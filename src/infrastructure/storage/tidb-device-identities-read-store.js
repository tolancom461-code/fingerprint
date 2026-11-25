import { BIOMETRIC_TABLES as T } from './biometric-table-names.js';

const MAX_ID = 18446744073709551615n;

/** All versioned identities, including explicitly archived registrations. No writes. */
export class TiDbDeviceIdentitiesReadStore {
  constructor(pool, { deviceUserIdentityEnabled = false } = {}) {
    if (typeof pool?.execute !== 'function' || typeof deviceUserIdentityEnabled !== 'boolean') {
      throw new TypeError('A device identity read pool and boolean identity mode are required');
    }
    this.pool = pool;
    this.deviceUserIdentityEnabled = deviceUserIdentityEnabled;
  }

  async listDeviceIdentitiesAfter(afterId, limit) {
    if (!this.deviceUserIdentityEnabled) {
      throw Object.assign(new Error('Versioned device identities are unavailable'), { code: 'DEVICE_IDENTITIES_UNAVAILABLE' });
    }
    const cursor = normalizeCursor(afterId);
    const pageSize = normalizeLimit(limit);
    // DECIMAL avoids signed parameter inference at UINT64_MAX in prepared SQL.
    const [rows] = await this.pool.execute(
      `SELECT CAST(u.id AS CHAR) AS id, CAST(u.device_id AS CHAR) AS device_id,
              u.device_user_id, u.display_name,
              COALESCE(d.display_name, d.serial_number) AS device_name, d.serial_number,
              CASE WHEN u.status = 'absent_from_device' THEN 'historical' ELSE 'current' END AS identity_status,
              DATE_FORMAT(u.first_seen_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS first_seen_at_utc,
              DATE_FORMAT(u.last_seen_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS last_seen_at_utc,
              DATE_FORMAT(u.identity_started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS identity_started_at_utc,
              DATE_FORMAT(u.identity_ended_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS identity_ended_at_utc
         FROM \`${T.deviceUsers}\` u
         LEFT JOIN \`${T.devices}\` d ON d.id = u.device_id
        WHERE u.id > CAST(? AS DECIMAL(20,0))
        ORDER BY u.id ASC
        LIMIT ${pageSize + 1}`,
      [cursor],
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
  return Object.assign(new TypeError('Invalid device identity pagination'), { code: 'INVALID_INPUT', status: 400 });
}
