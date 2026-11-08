import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const T = BIOMETRIC_TABLES.people;

export class TiDbPeopleStore {
  constructor(pool) { this.pool = pool; }

  async createPerson({ personCode, displayName, status = 'active', notes = null }) {
    const code = requiredText(personCode, 'personCode', 64);
    const name = requiredText(displayName, 'displayName', 255);
    const safeStatus = requiredText(status, 'status', 32);
    const safeNotes = optionalText(notes, 65535);

    try {
      const [result] = await this.pool.execute(
        `INSERT INTO \`${T}\` (person_code, display_name, status, notes)
         VALUES (?, ?, ?, ?)`,
        [code, name, safeStatus, safeNotes]
      );
      return this.getPersonById(result.insertId);
    } catch (error) {
      if (isDuplicateKey(error)) {
        const duplicate = new Error(`person_code already exists: ${code}`);
        duplicate.code = 'PERSON_CODE_CONFLICT';
        throw duplicate;
      }
      throw error;
    }
  }

  async getPersonById(id) {
    const [rows] = await this.pool.execute(
      `SELECT id, person_code, display_name, status, notes, created_at, updated_at
         FROM \`${T}\` WHERE id = ? LIMIT 1`,
      [normalizeId(id, 'personId')]
    );
    return rows?.[0] ?? null;
  }

  async getPersonByCode(personCode) {
    const [rows] = await this.pool.execute(
      `SELECT id, person_code, display_name, status, notes, created_at, updated_at
         FROM \`${T}\` WHERE person_code = ? LIMIT 1`,
      [requiredText(personCode, 'personCode', 64)]
    );
    return rows?.[0] ?? null;
  }

  async listPeople({ status = null, limit = 100, offset = 0 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 500, 100);
    const safeOffset = boundedInteger(offset, 0, 1_000_000_000, 0);
    const params = [];
    let where = '';
    if (status != null) {
      where = ' WHERE status = ?';
      params.push(requiredText(status, 'status', 32));
    }
    const [rows] = await this.pool.execute(
      `SELECT id, person_code, display_name, status, notes, created_at, updated_at
         FROM \`${T}\`${where}
        ORDER BY id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params
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
function optionalText(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new TypeError('text is too long');
  return text;
}
function boundedInteger(value, min, max, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}
