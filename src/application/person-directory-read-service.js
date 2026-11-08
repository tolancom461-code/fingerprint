export class PersonDirectoryReadService {
  constructor({ readStore }) { this.readStore = readStore; }

  async list({ search = '', status = 'active', afterCode = '', limit = 100 } = {}) {
    const safeSearch = normalizeSearch(search);
    const safeStatus = normalizeStatus(status);
    const safeAfterCode = normalizeAfterCode(afterCode);
    const pageSize = normalizeLimit(limit);
    const rows = await this.readStore.listPeople({
      search: safeSearch,
      status: safeStatus,
      afterCode: safeAfterCode,
      limit: pageSize
    });
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = pageRows.map(publicPerson);
    const nextAfterCode = pageRows.length > 0 ? String(pageRows.at(-1).person_code) : safeAfterCode;

    return {
      apiVersion: 'v1',
      items,
      page: {
        afterCode: safeAfterCode,
        nextAfterCode,
        limit: pageSize,
        hasMore
      }
    };
  }
}

function publicPerson(row) {
  return {
    personCode: String(row.person_code),
    displayName: String(row.display_name),
    status: String(row.status)
  };
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

function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new TypeError('limit must be an integer between 1 and 500');
  return n;
}
