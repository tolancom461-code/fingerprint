import { PunchStore } from '../../ports/punch-store.js';
import { BIOMETRIC_TABLES } from './biometric-table-names.js';
import { AUTOMATIC_FINALIZATION_PENDING_ISSUE } from '../../domain/finalization.js';
import { listDeviceUserIdentities, lockDeviceForUserIdentity } from './tidb-device-store.js';

const PUNCHES = BIOMETRIC_TABLES.punches;
const PROCESSING = BIOMETRIC_TABLES.eventProcessing;
const USERS = BIOMETRIC_TABLES.deviceUsers;
const DEVICES = BIOMETRIC_TABLES.devices;
const ISSUES = BIOMETRIC_TABLES.finalizationIssues;

export class TiDbPunchStore extends PunchStore {
  constructor({ pool, retryDelaySeconds = 30, deviceUserIdentityEnabled = false }) {
    super();
    this.pool = pool;
    this.deviceUserIdentityEnabled = deviceUserIdentityEnabled;
    const delay = Number(retryDelaySeconds);
    if (!Number.isInteger(delay) || delay < 1 || delay > 3600) throw new Error('retryDelaySeconds must be between 1 and 3600');
    this.retryDelaySeconds = delay;
  }

  async init() {}

  async putIfAbsent(punch, { createAutomaticFinalizationIntent = punch?.automaticFinalizationEligible === true } = {}) {
    if (typeof createAutomaticFinalizationIntent !== 'boolean') throw new TypeError('createAutomaticFinalizationIntent must be a boolean');
    requireDbId(punch.ingestEventId, 'punch.ingestEventId');
    requireDbId(punch.deviceId, 'punch.deviceId');
    if (!punch.deviceUserId) throw new Error('punch.deviceUserId is required for database storage');
    if (!punch.deviceEventTime) throw new Error('punch.deviceEventTime is required for database storage');

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (this.deviceUserIdentityEnabled) await lockDeviceForUserIdentity(connection, punch.deviceId);
      await connection.execute(
        `INSERT INTO \`${PROCESSING}\` (ingest_event_id, status)
         VALUES (?, 'pending')
         ON DUPLICATE KEY UPDATE ingest_event_id = VALUES(ingest_event_id)`,
        [punch.ingestEventId]
      );

      await connection.execute(
        `UPDATE \`${PROCESSING}\`
            SET status = 'processing',
                attempt_count = attempt_count + 1,
                last_attempt_at = CURRENT_TIMESTAMP(6),
                next_attempt_at = NULL,
                last_error_code = NULL,
                last_error_message = NULL
          WHERE ingest_event_id = ?`,
        [punch.ingestEventId]
      );

      let inserted = false;
      let insertedPunchId = null;
      const identity = this.deviceUserIdentityEnabled ? await identifyPunchUser(connection, punch) : null;
      try {
        const [insertResult] = await connection.execute(
          `INSERT INTO \`${PUNCHES}\` (
             ingest_event_id, event_key, event_key_strategy, event_key_version,
             vendor_dedupe_key, vendor_dedupe_strategy, vendor_dedupe_version,
             device_id, vendor, serial_number, device_user_id, device_event_time_raw,
             device_event_time_local, device_timezone, device_event_time_utc,
             raw_status, punch_state, raw_verify, verification_method, work_code,
             canonical_schema_version, vendor_metadata, wire_hash, parser_version, received_at${this.deviceUserIdentityEnabled ? ', device_user_row_id' : ''}
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?${this.deviceUserIdentityEnabled ? ', ?' : ''})`,
          [
            punch.ingestEventId,
            punch.eventKey,
            punch.eventKeyStrategy,
            punch.eventKeyVersion,
            punch.vendorDedupeKey,
            punch.vendorDedupeStrategy,
            punch.vendorDedupeVersion,
            punch.deviceId,
            punch.vendor,
            punch.serialNumber,
            punch.deviceUserId,
            punch.deviceEventTime,
            punch.deviceEventTime,
            punch.deviceTimezone ?? null,
            punch.deviceEventTimeUtc ?? null,
            punch.rawStatus,
            punch.punchState,
            punch.rawVerify,
            punch.verificationMethod,
            punch.workCode,
            jsonOrNull({
              delimiter: punch.delimiter ?? null,
              extraFields: [...(punch.extraFields ?? [])],
              wireSourceBytes: punch.wireSourceBytes ?? null
            }),
            punch.wireHash,
            punch.parserVersion,
            toSqlDateTime(punch.receivedAt),
            ...(this.deviceUserIdentityEnabled ? [identity?.id ?? null] : [])
          ]
        );
        inserted = true;
        insertedPunchId = positiveIdText(insertResult?.insertId, 'inserted punch id');
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
      }

      if (inserted && createAutomaticFinalizationIntent) {
        await connection.execute(
          `INSERT INTO \`${ISSUES}\` (
             source_punch_id, issue_type, status, details, first_seen_at, last_seen_at
           ) VALUES (?, ?, 'open', NULL, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))
           ON DUPLICATE KEY UPDATE
             status = 'open',
             last_seen_at = CURRENT_TIMESTAMP(6),
             resolved_at = NULL,
             resolution_note = NULL`,
          [insertedPunchId, AUTOMATIC_FINALIZATION_PENDING_ISSUE]
        );
      }

      const receivedAt = toSqlDateTime(punch.receivedAt);
      if (!this.deviceUserIdentityEnabled) {
        await connection.execute(
          `INSERT INTO \`${USERS}\` (
             device_id, device_user_id, status, metadata_schema_version, first_seen_at, last_seen_at
           ) VALUES (?, ?, 'seen', 1, ?, ?)
           ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)`,
          [punch.deviceId, punch.deviceUserId, receivedAt, receivedAt]
        );
      } else if (inserted && identity && identity.status !== 'absent_from_device' && identity.identity_ended_at == null) {
        await connection.execute(
          `UPDATE \`${USERS}\`
              SET last_seen_at = CASE WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ? ELSE last_seen_at END
            WHERE id = ? AND device_id = ? AND device_user_id = ?
              AND identity_ended_at IS NULL AND status <> 'absent_from_device'`,
          [receivedAt, receivedAt, identity.id, punch.deviceId, punch.deviceUserId]);
      }

      await connection.execute(
        `UPDATE \`${DEVICES}\`
            SET last_event_at = CASE
                  WHEN last_event_at IS NULL OR last_event_at < ? THEN ?
                  ELSE last_event_at
                END,
                last_seen_at = CASE
                  WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ?
                  ELSE last_seen_at
                END
          WHERE id = ?`,
        [
          punch.deviceEventTime, punch.deviceEventTime,
          toSqlDateTime(punch.receivedAt), toSqlDateTime(punch.receivedAt),
          punch.deviceId
        ]
      );

      await connection.execute(
        `UPDATE \`${PROCESSING}\`
            SET status = 'processed',
                processed_at = CURRENT_TIMESTAMP(6),
                next_attempt_at = NULL,
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = NULL,
                last_error_message = NULL
          WHERE ingest_event_id = ?`,
        [punch.ingestEventId]
      );

      await connection.commit();
      return inserted
        ? { status: 'inserted', punchId: insertedPunchId }
        : { status: 'duplicate' };
    } catch (error) {
      await safeRollback(connection);
      await this.#markRetry(punch.ingestEventId, error);
      throw error;
    } finally {
      connection.release();
    }
  }

  async #markRetry(ingestEventId, error) {
    const code = safeErrorCode(error);
    const message = safeErrorMessage(error);
    try {
      await this.pool.execute(
        `INSERT INTO \`${PROCESSING}\` (
           ingest_event_id, status, attempt_count, next_attempt_at, last_attempt_at,
           last_error_code, last_error_message
         ) VALUES (?, 'retry', 1, DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ${this.retryDelaySeconds} SECOND), CURRENT_TIMESTAMP(6), ?, ?)
         ON DUPLICATE KEY UPDATE
           status = 'retry',
           attempt_count = attempt_count + 1,
           next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ${this.retryDelaySeconds} SECOND),
           last_attempt_at = CURRENT_TIMESTAMP(6),
           last_error_code = VALUES(last_error_code),
           last_error_message = VALUES(last_error_message),
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL`,
        [ingestEventId, code, message]
      );
    } catch {
      // The durable ingest record remains authoritative even if retry metadata cannot be updated.
    }
  }
}

async function identifyPunchUser(connection, punch) {
  let identities = await listDeviceUserIdentities(connection, punch.deviceId, punch.deviceUserId);
  if (identities.length === 0) {
    const receivedAt = toSqlDateTime(punch.receivedAt);
    const [result] = await connection.execute(
      `INSERT INTO \`${USERS}\` (device_id, device_user_id, status, metadata_schema_version, first_seen_at, last_seen_at)
       VALUES (?, ?, 'seen', 1, ?, ?)`, [punch.deviceId, punch.deviceUserId, receivedAt, receivedAt]);
    identities = [{ id: positiveIdText(result?.insertId, 'inserted device user id'), status: 'seen',
      identity_started_at: null, identity_ended_at: null }];
  }

  const eventTime = orderedUtcTime(punch.deviceEventTimeUtc);
  if (!eventTime) return null;
  const candidates = [];
  for (const identity of identities) {
    const start = orderedUtcTime(identity.identity_started_at);
    const end = orderedUtcTime(identity.identity_ended_at);
    if ((identity.identity_started_at != null && !start) || (identity.identity_ended_at != null && !end) ||
        (start && end && end <= start)) return null;
    // Older archived rows may predate capture of their retirement time. Their unknown end cannot identify a punch.
    if (identity.status === 'absent_from_device' && !end) continue;
    // An open identity without a known start is safe only for a PIN with no recorded reuse.
    if (!start && !end && identities.length > 1) continue;
    if ((!start || eventTime >= start) && (!end || eventTime < end)) candidates.push(identity);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function orderedUtcTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(value);
  if (!match) return null;
  const seconds = `${match[1]}T${match[2]}`;
  const date = new Date(`${seconds}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== seconds) return null;
  return `${seconds}.${(match[3] ?? '').padEnd(6, '0')}`;
}

function positiveIdText(value, name) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be a positive integer`);
  return text;
}

function requireDbId(value, name) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} is required for database storage`);
  return text;
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function toSqlDateTime(value) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid datetime value: ${value}`);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function isDuplicateError(error) {
  return error?.errno === 1062 || error?.code === 'ER_DUP_ENTRY';
}

function safeErrorCode(error) {
  const value = String(error?.code ?? error?.errno ?? 'PUNCH_STORAGE_ERROR');
  return value.slice(0, 100);
}

function safeErrorMessage(error) {
  const value = String(error instanceof Error ? error.message : error ?? 'punch storage error');
  return value.replace(/[\r\n\0]/g, ' ').slice(0, 1000);
}

async function safeRollback(connection) {
  try { await connection.rollback(); } catch {}
}
