import { BIOMETRIC_TABLES } from './biometric-table-names.js';
import { HISTORICAL_REPLAY_VERSION_PREFIX } from '../../domain/historical-replay.js';

const T = BIOMETRIC_TABLES;

export class TiDbHistoricalReplayStore {
  constructor(pool) { this.pool = pool; }

  async getPersonById(personId) {
    const [rows] = await this.pool.execute(
      `SELECT id, person_code, display_name, status
         FROM \`${T.people}\`
        WHERE id = ?
        LIMIT 1`,
      [normalizeId(personId, 'personId')]
    );
    return rows?.[0] ?? null;
  }

  async summarizeOriginalFinalEvents({ personId, from, toExclusive }) {
    const [rows] = await this.pool.execute(
      `SELECT COUNT(*) AS count,
              MIN(f.event_time_local) AS earliest_event_time_local,
              MAX(f.event_time_local) AS latest_event_time_local
         FROM \`${T.finalEvents}\` f
        WHERE f.status = 'final'
          AND f.person_id = ?
          AND f.event_time_local >= ?
          AND f.event_time_local < ?
          AND f.finalization_version NOT LIKE ?`,
      [normalizeId(personId, 'personId'), dayStart(from), dayStart(toExclusive), `${HISTORICAL_REPLAY_VERSION_PREFIX}%`]
    );
    const row = rows?.[0] ?? {};
    return {
      count: Number(row.count ?? 0),
      earliest_event_time_local: row.earliest_event_time_local ?? null,
      latest_event_time_local: row.latest_event_time_local ?? null
    };
  }

  async listOriginalFinalEvents({ personId, from, toExclusive, limit = 1000 }) {
    const safeLimit = boundedInteger(limit, 1, 1000, 'limit');
    const [rows] = await this.pool.execute(
      `SELECT f.final_event_uuid, f.person_id, f.person_code, f.source_punch_id, f.device_id,
              f.device_reference, f.event_type, f.event_time_local, f.event_timezone,
              f.event_time_utc, f.verification_method, f.finalization_version
         FROM \`${T.finalEvents}\` f
        WHERE f.status = 'final'
          AND f.person_id = ?
          AND f.event_time_local >= ?
          AND f.event_time_local < ?
          AND f.finalization_version NOT LIKE ?
        ORDER BY f.event_time_local ASC, f.id ASC
        LIMIT ${safeLimit}`,
      [normalizeId(personId, 'personId'), dayStart(from), dayStart(toExclusive), `${HISTORICAL_REPLAY_VERSION_PREFIX}%`]
    );
    return rows ?? [];
  }

  async reissueFinalEvents({ events, auditEntry }) {
    if (!Array.isArray(events) || events.length === 0) return { reissuedCount: 0 };
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const event of events) await insertFinalEvent(connection, event);
      await insertAudit(connection, auditEntry);
      await connection.commit();
      return { reissuedCount: events.length };
    } catch (error) {
      try { await connection.rollback(); } catch { /* original error wins */ }
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function insertFinalEvent(executor, event) {
  await executor.execute(
    `INSERT INTO \`${T.finalEvents}\` (
       final_event_uuid, person_id, person_code, source_punch_id, device_id, device_reference,
       event_type, event_time_local, event_timezone, event_time_utc, verification_method,
       finalization_version, status, safe_metadata, finalized_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final', ?, CURRENT_TIMESTAMP(6))`,
    [
      requiredText(event.finalEventUuid, 'finalEventUuid', 36),
      normalizeId(event.personId, 'personId'),
      requiredText(event.personCode, 'personCode', 64),
      normalizeId(event.sourcePunchId, 'sourcePunchId'),
      normalizeId(event.deviceId, 'deviceId'),
      requiredText(event.deviceReference, 'deviceReference', 255),
      requiredText(event.eventType, 'eventType', 64),
      event.eventTimeLocal,
      requiredText(event.eventTimezone, 'eventTimezone', 100),
      event.eventTimeUtc,
      optionalText(event.verificationMethod, 64),
      requiredText(event.finalizationVersion, 'finalizationVersion', 32),
      jsonOrNull(event.safeMetadata)
    ]
  );
}

async function insertAudit(executor, entry) {
  await executor.execute(
    `INSERT INTO \`${T.auditLog}\` (
       actor_type, actor_reference, action_type, entity_type, entity_id,
       before_state, after_state, notes, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))`,
    [
      requiredText(entry.actorType, 'actorType', 32), optionalText(entry.actorReference, 128),
      requiredText(entry.actionType, 'actionType', 64), requiredText(entry.entityType, 'entityType', 64),
      entry.entityId == null ? null : normalizeId(entry.entityId, 'entityId'), jsonOrNull(entry.beforeState),
      jsonOrNull(entry.afterState), optionalText(entry.notes, 1000)
    ]
  );
}

function dayStart(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError('day must use YYYY-MM-DD');
  return `${text} 00:00:00`;
}
function boundedInteger(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new TypeError(`${name} must be between ${min} and ${max}`);
  return n;
}
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
