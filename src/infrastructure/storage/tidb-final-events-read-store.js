import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const T = BIOMETRIC_TABLES.finalEvents;

export class TiDbFinalEventsReadStore {
  constructor(pool) { this.pool = pool; }

  async listFinalEventsAfter(afterId, limit) {
    const cursor = normalizeCursor(afterId);
    const safeLimit = boundedLimit(limit);
    const [rows] = await this.pool.execute(
      `SELECT id, final_event_uuid, person_code, event_type,
              event_time_local, event_timezone, event_time_utc,
              verification_method, finalization_version
         FROM \`${T}\`
        WHERE status = 'final' AND id > ?
        ORDER BY id ASC
        LIMIT ${safeLimit + 1}`,
      [cursor]
    );
    return rows ?? [];
  }

  async getFinalEventByUuid(finalEventUuid) {
    const uuid = normalizeUuid(finalEventUuid);
    const [rows] = await this.pool.execute(
      `SELECT id, final_event_uuid, person_code, event_type,
              event_time_local, event_timezone, event_time_utc,
              verification_method, finalization_version
         FROM \`${T}\`
        WHERE status = 'final' AND final_event_uuid = ?
        LIMIT 1`,
      [uuid]
    );
    return rows?.[0] ?? null;
  }
}

function normalizeCursor(value) {
  const text = String(value ?? '0').trim();
  if (!/^\d+$/.test(text)) throw new TypeError('after_id must be a non-negative integer');
  const valueBigInt = BigInt(text);
  if (valueBigInt > 9223372036854775807n) throw new TypeError('after_id is out of range');
  return valueBigInt.toString();
}

function boundedLimit(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new TypeError('limit must be an integer between 1 and 500');
  return n;
}

function normalizeUuid(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw new TypeError('final event UUID is invalid');
  }
  return text;
}
