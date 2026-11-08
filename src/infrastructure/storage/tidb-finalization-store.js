import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const PUNCHES = BIOMETRIC_TABLES.punches;
const DEVICES = BIOMETRIC_TABLES.devices;
const DEVICE_USERS = BIOMETRIC_TABLES.deviceUsers;
const MAPPINGS = BIOMETRIC_TABLES.personDeviceUsers;
const PEOPLE = BIOMETRIC_TABLES.people;
const FINAL_EVENTS = BIOMETRIC_TABLES.finalEvents;
const ISSUES = BIOMETRIC_TABLES.finalizationIssues;

export class TiDbFinalizationStore {
  constructor(pool) { this.pool = pool; }

  async getPunchContext(punchId) {
    const id = normalizeId(punchId, 'punchId');
    const [rows] = await this.pool.execute(
      `SELECT p.id AS punch_id,
              p.device_id,
              p.device_user_id,
              p.punch_state,
              p.verification_method,
              p.device_event_time_local,
              p.device_timezone,
              p.device_event_time_utc,
              d.vendor,
              d.serial_number,
              du.id AS device_user_row_id,
              du.status AS device_user_status,
              m.id AS mapping_id,
              m.status AS mapping_status,
              m.active_from AS mapping_active_from,
              m.active_to AS mapping_active_to,
              person.id AS person_id,
              person.person_code,
              person.display_name,
              person.status AS person_status
         FROM \`${PUNCHES}\` p
         JOIN \`${DEVICES}\` d ON d.id = p.device_id
         LEFT JOIN \`${DEVICE_USERS}\` du
           ON du.device_id = p.device_id
          AND du.device_user_id = p.device_user_id
         LEFT JOIN \`${MAPPINGS}\` m ON m.device_user_row_id = du.id
         LEFT JOIN \`${PEOPLE}\` person ON person.id = m.person_id
        WHERE p.id = ?
        LIMIT 1`,
      [id]
    );
    return rows?.[0] ?? null;
  }

  async createFinalEvent(event) {
    const sourcePunchId = normalizeId(event.sourcePunchId, 'sourcePunchId');
    const finalizationVersion = requiredText(event.finalizationVersion, 'finalizationVersion', 32);
    try {
      const [result] = await this.pool.execute(
        `INSERT INTO \`${FINAL_EVENTS}\` (
           final_event_uuid, person_id, person_code, source_punch_id, device_id, device_reference,
           event_type, event_time_local, event_timezone, event_time_utc, verification_method,
           finalization_version, status, safe_metadata, finalized_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final', ?, CURRENT_TIMESTAMP(6))`,
        [
          requiredText(event.finalEventUuid, 'finalEventUuid', 36),
          normalizeId(event.personId, 'personId'),
          requiredText(event.personCode, 'personCode', 64),
          sourcePunchId,
          normalizeId(event.deviceId, 'deviceId'),
          requiredText(event.deviceReference, 'deviceReference', 255),
          requiredText(event.eventType, 'eventType', 64),
          event.eventTimeLocal,
          requiredText(event.eventTimezone, 'eventTimezone', 100),
          event.eventTimeUtc,
          optionalText(event.verificationMethod, 64),
          finalizationVersion,
          jsonOrNull(event.safeMetadata)
        ]
      );
      return this.getFinalEventById(result.insertId);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const existing = await this.getFinalEventBySourceVersion(sourcePunchId, finalizationVersion);
      if (!existing) throw error;
      return existing;
    }
  }

  async getFinalEventById(id) {
    const [rows] = await this.pool.execute(
      `SELECT id, final_event_uuid, person_id, person_code, source_punch_id, device_id,
              device_reference, event_type, event_time_local, event_timezone, event_time_utc,
              verification_method, finalization_version, status, safe_metadata, finalized_at, created_at
         FROM \`${FINAL_EVENTS}\`
        WHERE id = ? LIMIT 1`,
      [normalizeId(id, 'finalEventId')]
    );
    return rows?.[0] ?? null;
  }

  async getFinalEventBySourceVersion(sourcePunchId, finalizationVersion) {
    const [rows] = await this.pool.execute(
      `SELECT id, final_event_uuid, person_id, person_code, source_punch_id, device_id,
              device_reference, event_type, event_time_local, event_timezone, event_time_utc,
              verification_method, finalization_version, status, safe_metadata, finalized_at, created_at
         FROM \`${FINAL_EVENTS}\`
        WHERE source_punch_id = ? AND finalization_version = ? LIMIT 1`,
      [normalizeId(sourcePunchId, 'sourcePunchId'), requiredText(finalizationVersion, 'finalizationVersion', 32)]
    );
    return rows?.[0] ?? null;
  }

  async upsertIssue({ sourcePunchId, issueType, details = null }) {
    const punchId = normalizeId(sourcePunchId, 'sourcePunchId');
    const type = requiredText(issueType, 'issueType', 64);
    await this.pool.execute(
      `INSERT INTO \`${ISSUES}\` (
         source_punch_id, issue_type, status, details, first_seen_at, last_seen_at
       ) VALUES (?, ?, 'open', ?, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE
         status = 'open',
         details = VALUES(details),
         last_seen_at = CURRENT_TIMESTAMP(6),
         resolved_at = NULL,
         resolution_note = NULL`,
      [punchId, type, jsonOrNull(details)]
    );
    const [rows] = await this.pool.execute(
      `SELECT id, source_punch_id, issue_type, status, details, first_seen_at, last_seen_at,
              resolved_at, resolution_note, created_at, updated_at
         FROM \`${ISSUES}\`
        WHERE source_punch_id = ? AND issue_type = ? LIMIT 1`,
      [punchId, type]
    );
    return rows?.[0] ?? null;
  }

  async listOpenIssuePunchIds({ issueType, retryDelaySeconds = 30, limit = 100 } = {}) {
    const type = requiredText(issueType, 'issueType', 64);
    const delay = boundedInteger(retryDelaySeconds, 1, 3600, 'retryDelaySeconds');
    const safeLimit = boundedInteger(limit, 1, 500, 'limit');
    const [rows] = await this.pool.execute(
      `SELECT source_punch_id
         FROM \`${ISSUES}\`
        WHERE status = 'open'
          AND issue_type = ?
          AND last_seen_at <= DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL ${delay} SECOND)
        ORDER BY last_seen_at ASC, id ASC
        LIMIT ${safeLimit}`,
      [type]
    );
    return (rows ?? []).map((row) => Number(row.source_punch_id)).filter(Number.isSafeInteger);
  }

  async resolveIssue(sourcePunchId, issueType, resolutionNote = 'resolved') {
    const [result] = await this.pool.execute(
      `UPDATE \`${ISSUES}\`
          SET status = 'resolved',
              resolved_at = CURRENT_TIMESTAMP(6),
              resolution_note = ?
        WHERE source_punch_id = ?
          AND issue_type = ?
          AND status = 'open'`,
      [
        optionalText(resolutionNote, 1000),
        normalizeId(sourcePunchId, 'sourcePunchId'),
        requiredText(issueType, 'issueType', 64)
      ]
    );
    return { affectedRows: Number(result?.affectedRows ?? 0) };
  }

  async resolveOpenIssues(sourcePunchId, resolutionNote = 'finalization_succeeded') {
    const [result] = await this.pool.execute(
      `UPDATE \`${ISSUES}\`
          SET status = 'resolved',
              resolved_at = CURRENT_TIMESTAMP(6),
              resolution_note = ?
        WHERE source_punch_id = ? AND status = 'open'`,
      [optionalText(resolutionNote, 1000), normalizeId(sourcePunchId, 'sourcePunchId')]
    );
    return { affectedRows: Number(result?.affectedRows ?? 0) };
  }
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new TypeError(`${name} must be between ${min} and ${max}`);
  return number;
}

function isDuplicateKey(error) { return error?.code === 'ER_DUP_ENTRY' || Number(error?.errno) === 1062; }
function normalizeId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${name} must be a positive integer`);
  return id;
}
function requiredText(value, name, max) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  if (text.length > max) throw new TypeError(`${name} is too long`);
  return text;
}
function optionalText(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new TypeError('text is too long');
  return text;
}
function jsonOrNull(value) { return value == null ? null : JSON.stringify(value); }
