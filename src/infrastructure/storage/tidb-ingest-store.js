import { IngestStore } from '../../ports/ingest-store.js';
import { evaluateDeviceEventPolicy } from '../../domain/device-policy.js';
import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const I = BIOMETRIC_TABLES.ingestEvents;
const P = BIOMETRIC_TABLES.eventProcessing;
const D = BIOMETRIC_TABLES.devices;
const AUTOMATIC_ELIGIBILITY = 'automatic_finalization_eligible';

export class TiDbIngestStore extends IngestStore {
  constructor({ pool, deviceStore, replayLimit = 1000, autoFinalizeNewCaptures = false }) {
    super();
    this.pool = pool;
    this.deviceStore = deviceStore;
    this.replayLimit = replayLimit;
    if (typeof autoFinalizeNewCaptures !== 'boolean') throw new TypeError('autoFinalizeNewCaptures must be a boolean');
    this.autoFinalizeNewCaptures = autoFinalizeNewCaptures;
    this.eligibilityColumnAvailable = false;
    this.initialization = null;
  }

  async init() {
    if (!this.initialization) this.initialization = this.#initializeEligibility();
    return this.initialization;
  }

  async #initializeEligibility() {
    const [rows] = await this.pool.execute(
      `SELECT DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [P, AUTOMATIC_ELIGIBILITY]
    );
    if (!Array.isArray(rows) || rows.length > 1) throw eligibilityError('AUTOMATIC_ELIGIBILITY_SCHEMA_INVALID');
    if (rows.length === 0) {
      if (this.autoFinalizeNewCaptures) throw eligibilityError('AUTOMATIC_ELIGIBILITY_SCHEMA_REQUIRED');
      return;
    }
    const column = rows[0];
    if (String(column.DATA_TYPE ?? column.data_type).toLowerCase() !== 'tinyint' ||
        !/^tinyint(?:\([0-9]+\))?\s+unsigned$/i.test(String(column.COLUMN_TYPE ?? column.column_type)) ||
        String(column.IS_NULLABLE ?? column.is_nullable).toUpperCase() !== 'NO' ||
        String(column.COLUMN_DEFAULT ?? column.column_default) !== '0') {
      throw eligibilityError('AUTOMATIC_ELIGIBILITY_SCHEMA_INVALID');
    }
    this.eligibilityColumnAvailable = true;
  }

  async putIfAbsent(event) {
    await this.init();
    const device = await this.deviceStore.observe({
      device: { vendor: event.vendor, serialNumber: event.serialNumber },
      remoteAddress: event.remoteAddress,
      observedAt: toSqlDateTime(event.receivedAt),
      eventAt: event.canonicalPayload?.deviceEventTime ?? null
    });
    if (!device) throw new Error('biometric device could not be resolved');

    const policy = evaluateDeviceEventPolicy(device, event.canonicalPayload?.deviceEventTime ?? null);
    if (!policy.allowed) throw new Error(`biometric device policy denied event: ${policy.reason}`);

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      let inserted = false;
      let ingestEventId = null;

      try {
        const [result] = await connection.execute(
          `INSERT INTO \`${I}\` (
             ingest_key, storage_identity_version, device_id, vendor, serial_number,
             event_family, vendor_event_type, vendor_event_id, dedupe_key, dedupe_strategy,
             dedupe_version, wire_hash, capture_id, capture_index, adapter_version,
             parser_version, parse_valid, safe_to_acknowledge, unsafe_reason, source_bytes,
             source_field_count, payload_schema_version, safe_payload, source_ip, received_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          [
            event.ingestKey,
            event.storageIdentityVersion,
            device.id,
            event.vendor,
            event.serialNumber,
            event.eventFamily,
            event.vendorEventType,
            event.vendorEventId ?? null,
            event.dedupeKey,
            event.dedupeStrategy,
            event.dedupeVersion,
            event.wireHash,
            event.captureId ?? null,
            event.captureIndex ?? null,
            event.adapterVersion ?? null,
            event.parserVersion,
            event.parseValid ? 1 : 0,
            event.safeToAcknowledge ? 1 : 0,
            event.unsafeReason,
            event.sourceBytes,
            event.sourceFieldCount,
            jsonOrNull(event.canonicalPayload),
            event.remoteAddress,
            toSqlDateTime(event.receivedAt)
          ]
        );
        ingestEventId = result.insertId;
        inserted = true;
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        const existing = await selectExisting(connection, event, device.id);
        if (!existing) throw new Error('duplicate ingest event could not be resolved');
        ingestEventId = existing.id;
      }

      const row = await selectById(connection, ingestEventId);
      const hasCanonicalPayload = row?.safe_payload != null;
      const processingStatus = hasCanonicalPayload && policy.canonicalEligible ? 'pending' : 'not_applicable';
      const newAutomaticEligibility = inserted && this.autoFinalizeNewCaptures && hasCanonicalPayload &&
        policy.canonicalEligible && event.parseValid === true && event.safeToAcknowledge === true &&
        isOne(row?.parse_valid) && isOne(row?.safe_to_acknowledge);
      await connection.execute(
        `INSERT INTO \`${P}\` (ingest_event_id, status${this.eligibilityColumnAvailable ? `, ${AUTOMATIC_ELIGIBILITY}` : ''})
         VALUES (?, ?${this.eligibilityColumnAvailable ? ', ?' : ''})
         ON DUPLICATE KEY UPDATE ingest_event_id = VALUES(ingest_event_id)`,
        [ingestEventId, processingStatus, ...(this.eligibilityColumnAvailable ? [newAutomaticEligibility ? 1 : 0] : [])]
      );
      let automaticEligibility = 0;
      if (this.eligibilityColumnAvailable) {
        const [processing] = await connection.execute(
          `SELECT ${AUTOMATIC_ELIGIBILITY} FROM \`${P}\` WHERE ingest_event_id = ? LIMIT 1`, [ingestEventId]
        );
        if (!Array.isArray(processing) || processing.length !== 1 ||
            ![0, 1, '0', '1'].includes(processing[0]?.[AUTOMATIC_ELIGIBILITY])) {
          throw eligibilityError('AUTOMATIC_ELIGIBILITY_STATE_INVALID');
        }
        automaticEligibility = processing[0][AUTOMATIC_ELIGIBILITY];
      }

      await connection.commit();
      return {
        status: inserted ? 'inserted' : 'duplicate',
        record: fromRow(row, device, automaticEligibility),
        canonicalEligible: hasCanonicalPayload && policy.canonicalEligible,
        policyReason: policy.reason
      };
    } catch (error) {
      await safeRollback(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async list() {
    await this.init();
    const [rows] = await this.pool.execute(
      `SELECT i.*,
              ${this.eligibilityColumnAvailable ? `p.${AUTOMATIC_ELIGIBILITY}` : '0'} AS ${AUTOMATIC_ELIGIBILITY},
              d.timezone AS device_timezone,
              d.mode AS device_mode,
              d.status AS device_status,
              d.accept_events_from AS device_accept_events_from
         FROM \`${I}\` i
         JOIN \`${D}\` d ON d.id = i.device_id
         LEFT JOIN \`${P}\` p ON p.ingest_event_id = i.id
        WHERE i.safe_payload IS NOT NULL
          AND d.status = 'active'
          AND d.mode IN ('test', 'live')
          AND (p.ingest_event_id IS NULL OR p.status IN ('pending', 'retry'))
          AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= CURRENT_TIMESTAMP(6))
        ORDER BY i.id ASC
        LIMIT ${Number(this.replayLimit)}`
    );

    const eligible = [];
    for (const row of rows) {
      const device = {
        timezone: row.device_timezone,
        mode: row.device_mode,
        status: row.device_status,
        accept_events_from: row.device_accept_events_from
      };
      const ingest = fromRow(row, device);
      const policy = evaluateDeviceEventPolicy(device, ingest.canonicalPayload?.deviceEventTime ?? null);
      if (policy.allowed && policy.canonicalEligible) {
        eligible.push(ingest);
        continue;
      }
      if (policy.allowed && !policy.canonicalEligible) {
        await this.pool.execute(
          `INSERT INTO \`${P}\` (ingest_event_id, status)
           VALUES (?, 'not_applicable')
           ON DUPLICATE KEY UPDATE
             status = 'not_applicable',
             next_attempt_at = NULL,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL`,
          [row.id]
        );
      }
    }
    return eligible;
  }
}

async function selectExisting(connection, event, deviceId) {
  const [rows] = await connection.execute(
    `SELECT * FROM \`${I}\`
      WHERE ingest_key = ?
         OR (device_id = ? AND dedupe_strategy = ? AND dedupe_version = ? AND dedupe_key = ?)
      ORDER BY id ASC
      LIMIT 1`,
    [event.ingestKey, deviceId, event.dedupeStrategy, event.dedupeVersion, event.dedupeKey]
  );
  return rows?.[0] ?? null;
}

async function selectById(connection, id) {
  const [rows] = await connection.execute(`SELECT * FROM \`${I}\` WHERE id = ? LIMIT 1`, [id]);
  return rows?.[0] ?? null;
}

function fromRow(row, device = {}, automaticEligibility = row?.[AUTOMATIC_ELIGIBILITY]) {
  if (!row) throw new Error('ingest row is required');
  const payload = parseJson(row.safe_payload);
  return Object.freeze({
    ingestEventId: row.id,
    deviceId: row.device_id,
    ingestKey: row.ingest_key,
    storageIdentityVersion: row.storage_identity_version,
    dedupeKey: row.dedupe_key,
    dedupeStrategy: row.dedupe_strategy,
    dedupeVersion: row.dedupe_version,
    wireHash: row.wire_hash,
    vendor: row.vendor,
    serialNumber: row.serial_number,
    deviceKey: `${row.vendor}:${row.serial_number}`,
    deviceTimezone: safeText(device.timezone ?? row.device_timezone),
    eventFamily: row.event_family,
    vendorEventType: row.vendor_event_type,
    vendorEventId: row.vendor_event_id ?? null,
    adapterVersion: row.adapter_version ?? null,
    parserVersion: row.parser_version,
    parseValid: Boolean(row.parse_valid),
    safeToAcknowledge: Boolean(row.safe_to_acknowledge),
    unsafeReason: row.unsafe_reason ?? null,
    sourceBytes: nullableNumber(row.source_bytes),
    sourceFieldCount: nullableNumber(row.source_field_count),
    captureId: row.capture_id ?? null,
    captureIndex: nullableNumber(row.capture_index),
    canonicalPayload: payload ? Object.freeze(payload) : null,
    automaticFinalizationEligible: isOne(automaticEligibility),
    remoteAddress: row.source_ip ?? null,
    receivedAt: toIsoLike(row.received_at)
  });
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { throw new Error('stored safe_payload is not valid JSON'); }
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

function safeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function toSqlDateTime(value) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid datetime value: ${value}`);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function toIsoLike(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? '').trim();
  if (!text) return text;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) return `${text.replace(' ', 'T')}Z`;
  return text;
}

function isDuplicateError(error) {
  return error?.errno === 1062 || error?.code === 'ER_DUP_ENTRY';
}

async function safeRollback(connection) {
  try { await connection.rollback(); } catch {}
}

function isOne(value) { return value === 1 || value === '1'; }
function eligibilityError(code) {
  return Object.assign(new Error('Automatic finalization eligibility is unavailable or invalid'), { code });
}
