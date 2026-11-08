import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const T = BIOMETRIC_TABLES.people;

export class TiDbPersonDirectoryReadStore {
  constructor(pool) { this.pool = pool; }

  async listPeople({ search = '', status = 'active', afterCode = '', limit = 100 } = {}) {
    const safeSearch = normalizeSearch(search);
    const safeStatus = normalizeStatus(status);
    const safeAfterCode = normalizeAfterCode(afterCode);
    const safeLimit = boundedLimit(limit);
    const where = [];
    const params = [];

    if (safeStatus !== 'all') {
      where.push('status = ?');
      params.push(safeStatus);
    }

    if (safeSearch) {
      where.push('(person_code LIKE ? OR display_name LIKE ?)');
      const pattern = `%${escapeLike(safeSearch)}%`;
      params.push(pattern, pattern);
    }

    if (safeAfterCode) {
      where.push('person_code > ?');
      params.push(safeAfterCode);
    }

    const [rows] = await this.pool.execute(
      `SELECT person_code, display_name, status
         FROM \`${T}\`
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY person_code ASC
        LIMIT ${safeLimit + 1}`,
      params
    );
    return rows ?? [];
  }
}

function normalizeSearch(value) {
  const text = String(value ?? '').trim();
  if (text.length > 120) throw new TypeError('search is too long');
  return text;
}

function normalizeStatus(value) {
  const text = String(value ?? 'active').trim().toLowerCase() || 'active';
  if (!['active', 'inactive', 'all'].includes(text)) throw new TypeError('status must be active, inactive, or all');
  return text;
}

function normalizeAfterCode(value) {
  const text = String(value ?? '').trim();
  if (text.length > 64) throw new TypeError('after_code is too long');
  return text;
}

function boundedLimit(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new TypeError('limit must be an integer between 1 and 500');
  return n;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
