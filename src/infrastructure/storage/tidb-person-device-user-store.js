import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const M = BIOMETRIC_TABLES.personDeviceUsers;
const U = BIOMETRIC_TABLES.deviceUsers;
const P = BIOMETRIC_TABLES.people;
const D = BIOMETRIC_TABLES.devices;

export class TiDbPersonDeviceUserStore {
  constructor(pool) { this.pool = pool; }

  async getDeviceUserByRowId(id) {
    const [rows] = await this.pool.execute(
      `SELECT u.id, u.device_id, u.device_user_id, u.display_name, u.status,
              u.first_seen_at, u.last_seen_at, d.vendor, d.serial_number
         FROM \`${U}\` u
         JOIN \`${D}\` d ON d.id = u.device_id
        WHERE u.id = ? LIMIT 1`,
      [normalizeId(id, 'deviceUserRowId')]
    );
    return rows?.[0] ?? null;
  }

  async getMappingByDeviceUserRowId(id) {
    const [rows] = await this.pool.execute(
      `SELECT m.id, m.person_id, m.device_user_row_id, m.status, m.active_from, m.active_to,
              p.person_code, p.display_name
         FROM \`${M}\` m
         JOIN \`${P}\` p ON p.id = m.person_id
        WHERE m.device_user_row_id = ? LIMIT 1`,
      [normalizeId(id, 'deviceUserRowId')]
    );
    return rows?.[0] ?? null;
  }

  async createMapping({ personId, deviceUserRowId, status = 'active', activeFrom = null }) {
    const safePersonId = normalizeId(personId, 'personId');
    const safeDeviceUserRowId = normalizeId(deviceUserRowId, 'deviceUserRowId');
    try {
      const [result] = await this.pool.execute(
        `INSERT INTO \`${M}\` (person_id, device_user_row_id, status, active_from)
         VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP(6)))`,
        [safePersonId, safeDeviceUserRowId, requiredText(status, 'status', 32), activeFrom]
      );
      const [rows] = await this.pool.execute(
        `SELECT id, person_id, device_user_row_id, status, active_from, active_to, created_at, updated_at
           FROM \`${M}\` WHERE id = ? LIMIT 1`,
        [result.insertId]
      );
      return rows?.[0] ?? null;
    } catch (error) {
      if (isDuplicateKey(error)) {
        const duplicate = new Error(`device user is already mapped: ${safeDeviceUserRowId}`);
        duplicate.code = 'DEVICE_USER_MAPPING_CONFLICT';
        throw duplicate;
      }
      throw error;
    }
  }

  async listUnmappedDeviceUsers({ limit = 100, offset = 0 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 500, 100);
    const safeOffset = boundedInteger(offset, 0, 1_000_000_000, 0);
    const [rows] = await this.pool.execute(
      `SELECT u.id, u.device_id, u.device_user_id, u.display_name, u.status,
              u.first_seen_at, u.last_seen_at, d.vendor, d.serial_number
         FROM \`${U}\` u
         JOIN \`${D}\` d ON d.id = u.device_id
         LEFT JOIN \`${M}\` m ON m.device_user_row_id = u.id
        WHERE m.id IS NULL
        ORDER BY u.last_seen_at DESC, u.id DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`
    );
    return rows ?? [];
  }
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
function boundedInteger(value, min, max, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}
