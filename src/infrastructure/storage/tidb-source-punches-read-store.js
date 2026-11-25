import { BIOMETRIC_TABLES } from './biometric-table-names.js';
import { normalizeZktecoAttendance } from '../vendors/zkteco/attlog-normalization.js';

const MAX_ID = 18446744073709551615n;
const STATES = ['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out'];
const RAW_STATE = `CASE p.raw_status ${STATES.map((state, index) => `WHEN '${index}' THEN '${state}'`).join(' ')} END`;
// This is a historical interpretation already approved by the existing portal.
// Recheck the authoritative profile so removing/changing it disables this fallback.
const HISTORICAL_PROFILES = ['AJE1261900133'].filter(serialNumber => STATES.every((state, index) =>
  normalizeZktecoAttendance({ serialNumber, rawStatus: String(index) }).punchState === state));

/** Supplied read pool only; no configuration, joins to mutable identities, or writes. */
export class TiDbSourcePunchesReadStore {
  constructor(pool, { deviceUserIdentityEnabled = false } = {}) {
    if (typeof pool?.execute !== 'function' || typeof deviceUserIdentityEnabled !== 'boolean') {
      throw new TypeError('A source punch read pool and boolean identity mode are required');
    }
    this.pool = pool;
    this.deviceUserIdentityEnabled = deviceUserIdentityEnabled;
  }

  async listSourcePunchesAfter(afterId, limit) {
    const cursor = normalizeCursor(afterId);
    const pageSize = normalizeLimit(limit);
    const identity = this.deviceUserIdentityEnabled ? 'CAST(p.device_user_row_id AS CHAR)' : 'NULL';
    const historical = HISTORICAL_PROFILES.length
      ? `(p.punch_state IS NULL AND p.vendor = 'zkteco' AND p.serial_number IN (${HISTORICAL_PROFILES.map(() => '?').join(', ')}))`
      : 'FALSE';
    const [rows] = await this.pool.execute(
      `SELECT CAST(p.id AS CHAR) AS id, p.event_key, CAST(p.device_id AS CHAR) AS device_id,
              p.device_user_id, ${identity} AS device_user_row_id,
              COALESCE(p.punch_state, ${RAW_STATE}) AS punch_state, p.raw_status,
              DATE_FORMAT(p.device_event_time_utc, '%Y-%m-%dT%H:%i:%s.%fZ') AS device_event_time_utc
         FROM \`${BIOMETRIC_TABLES.punches}\` p
        WHERE p.id > CAST(? AS DECIMAL(20,0))
          AND p.raw_status IN ('0', '1', '2', '3', '4', '5')
          AND p.device_event_time_utc IS NOT NULL
          AND (p.punch_state = ${RAW_STATE} OR ${historical})
        ORDER BY p.id ASC
        LIMIT ${pageSize + 1}`,
      [cursor, ...HISTORICAL_PROFILES],
    );
    return rows ?? [];
  }
}

function normalizeCursor(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)
    || (typeof value === 'number' && !Number.isSafeInteger(value))) throw invalidInput();
  const text = String(value);
  if (!/^[0-9]{1,20}$/.test(text) || BigInt(text) > MAX_ID) throw invalidInput();
  return BigInt(text).toString();
}
function normalizeLimit(value) {
  if (!['string', 'number'].includes(typeof value)
    || (typeof value === 'string' && !/^[0-9]+$/.test(value))) throw invalidInput();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 500) throw invalidInput();
  return number;
}
function invalidInput() {
  return Object.assign(new TypeError('Invalid source punch pagination'), { code: 'INVALID_INPUT', status: 400 });
}
