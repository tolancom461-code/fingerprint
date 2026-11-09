import { createReadOnlyPortalService } from './read-only-portal-service.js';

export function createIngestPortalService({ readStore }) {
  if (['getIntakeCounts', 'pageReceivedPunches', 'pageDeviceUsers'].some(method => typeof readStore?.[method] !== 'function')) throw invalid();
  const base = createReadOnlyPortalService({ readStore });
  return Object.freeze({ ...base,
    async overview() {
      const [summary, counts] = await Promise.all([base.overview(), readStore.getIntakeCounts()]);
      return { ...summary, mode: 'database-ingest', counts: { ...summary.counts,
        received: integer(counts.received, 0, Number.MAX_SAFE_INTEGER), deviceUsers: integer(counts.deviceUsers, 0, Number.MAX_SAFE_INTEGER) } };
    },
    async listReceivedPunches(filters) {
      const query = readFilters(filters);
      return projectPage(await readStore.pageReceivedPunches(query), query, row => ({
        id: id(row.id), deviceUserId: text(row.device_user_id, true),
        eventTimeLocal: text(row.device_event_time_local, true), eventTimeUtc: utc(row.device_event_time_utc, true),
        receivedAt: utc(row.received_at), parseValid: bit(row.parse_valid),
        processingStatus: text(row.processing_status), hasFinalEvent: bit(row.has_final_event),
        deviceName: text(row.device_name), serialNumber: text(row.serial_number)
      }));
    },
    async listDeviceUsers(filters) {
      const query = readFilters(filters);
      return projectPage(await readStore.pageDeviceUsers(query), query, row => ({
        id: id(row.id), deviceUserId: text(row.device_user_id), displayName: text(row.display_name, true),
        status: text(row.status), lastSeenAt: utc(row.last_seen_at, true), deviceName: text(row.device_name),
        mappedPersonCode: text(row.mapped_person_code, true), mappedPersonName: text(row.mapped_person_name, true)
      }));
    }
  });
}
function readFilters(filters = {}) {
  const badInput = () => Object.assign(new TypeError('Invalid intake list filters'), { code: 'INVALID_INPUT', status: 400 });
  const number = (value, fallback, maximum) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!['string', 'number'].includes(typeof value)) throw badInput();
    if (typeof value === 'string' && !/^[0-9]+$/.test(value)) throw badInput();
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw badInput();
    return result;
  };
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw badInput();
  const search = filters.search ?? '';
  if (typeof search !== 'string' || search.length > 100) throw badInput();
  return { page: number(filters.page, 1, 1000000), limit: number(filters.limit, 10, 100), search: search.trim() };
}
function projectPage(result, query, project) {
  if (!Array.isArray(result?.items) || !result.page || result.items.length > query.limit) throw invalid();
  const total = integer(result.page.total, 0, Number.MAX_SAFE_INTEGER);
  const totalPages = Math.max(1, Math.ceil(total / query.limit));
  if (result.page.number !== query.page || result.page.limit !== query.limit || result.page.totalPages !== totalPages || result.items.length > total) throw invalid();
  return { items: result.items.map(project), page: { number: query.page, limit: query.limit, total, totalPages } };
}
function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}
function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid();
  const result = String(value ?? '');
  if (!/^[1-9][0-9]{0,19}$/.test(result)) throw invalid();
  return result;
}
function text(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 512) throw invalid();
  return value;
}
function bit(value) {
  if (![0, 1, '0', '1'].includes(value)) throw invalid();
  return value === 1 || value === '1';
}
function utc(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw invalid();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,6})?Z?$/.exec(value);
  if (!match || Number(match[1].slice(0, 4)) < 1) throw invalid();
  const formatted = `${match[1]}T${match[2]}${match[3] ?? ''}Z`;
  const instant = new Date(formatted);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 19) !== formatted.slice(0, 19)) throw invalid();
  return formatted;
}
function invalid() { return Object.assign(new Error('Ingest portal data could not be read'), { code: 'INGEST_PORTAL_DATA_INVALID' }); }
