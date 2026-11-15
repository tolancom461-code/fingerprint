import { createReadOnlyPortalService } from './read-only-portal-service.js';

const profileFields = ['Pri', 'Grp', 'TZ', 'Verify', 'StartDatetime', 'EndDatetime'];
const punchStates = new Set(['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out']);

export function createIngestPortalService({ readStore }) {
  if (['getIntakeCounts', 'pageReceivedPunches', 'pageDeviceUsers'].some(method => typeof readStore?.[method] !== 'function')) throw invalid();
  const base = createReadOnlyPortalService({ readStore });
  return Object.freeze({ ...base,
    async overview() {
      const [summary, counts] = await Promise.all([base.overview(), readStore.getIntakeCounts()]);
      const extraCounts = counts.historicalDeviceUsers === undefined ? {} : {
        historicalDeviceUsers: integer(counts.historicalDeviceUsers, 0, Number.MAX_SAFE_INTEGER),
        allDeviceUsers: integer(counts.allDeviceUsers, 0, Number.MAX_SAFE_INTEGER)
      };
      if (extraCounts.historicalDeviceUsers !== undefined && counts.deviceUsers + extraCounts.historicalDeviceUsers !== extraCounts.allDeviceUsers) throw invalid();
      return { ...summary, mode: 'database-ingest', counts: { ...summary.counts,
        received: integer(counts.received, 0, Number.MAX_SAFE_INTEGER), deviceUsers: integer(counts.deviceUsers, 0, Number.MAX_SAFE_INTEGER), ...extraCounts } };
    },
    async listReceivedPunches(filters) {
      const query = readFilters(filters);
      if (filters?.deviceUserRowId !== undefined) {
        const rowId = filters.deviceUserRowId;
        if (typeof rowId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(rowId) || BigInt(rowId) > 18446744073709551615n) throw badFilters();
        query.deviceUserRowId = rowId;
      }
      return projectPage(await readStore.pageReceivedPunches(query), query, row => ({
        id: id(row.id), deviceUserId: text(row.device_user_id, true),
        eventTimeLocal: text(row.device_event_time_local, true), eventTimeUtc: utc(row.device_event_time_utc, true),
        receivedAt: utc(row.received_at), parseValid: bit(row.parse_valid),
        processingStatus: text(row.processing_status), hasFinalEvent: bit(row.has_final_event),
        deviceName: text(row.device_name), serialNumber: text(row.serial_number),
        ...(query.deviceUserRowId === undefined ? {} : {
          devicePunchState: text(row.device_punch_state ?? null, true),
          punchState: punchStates.has(row.punch_state) ? row.punch_state : null
        })
      }));
    },
    async listDeviceUserChanges(filters) {
      const query = readFilters(filters);
      const kind = filters?.kind;
      if (!['added', 'updated'].includes(kind)) throw badFilters();
      if (!readStore.directorySyncEnabled || typeof readStore.pageDeviceUserChanges !== 'function') throw invalid();
      return projectPage(await readStore.pageDeviceUserChanges({ ...query, kind }), query, row => ({
        id: id(row.id), deviceUserRowId: id(row.device_user_row_id), deviceUserId: text(row.device_user_id),
        deviceName: text(row.device_name), occurredAt: utc(row.occurred_at),
        before: kind === 'updated' ? changeSnapshot(row, 'before') : null,
        after: changeSnapshot(row, 'after')
      }));
    },
    async listDeviceUsers(filters) {
      const query = readDeviceUserFilters(filters);
      const result = await readStore.pageDeviceUsers(query);
      const page = projectPage(result, query, row => ({
        id: id(row.id), deviceUserId: text(row.device_user_id), displayName: text(row.display_name, true),
        status: text(row.status), lastSeenAt: utc(row.last_seen_at, true), deviceName: text(row.device_name),
        mappedPersonCode: text(row.mapped_person_code, true), mappedPersonName: text(row.mapped_person_name, true)
      }));
      if (result.rosterCounts === undefined) return page;
      const rosterCounts = Object.fromEntries(['current', 'historical', 'all'].map(key => [key, integer(result.rosterCounts?.[key], 0, Number.MAX_SAFE_INTEGER)]));
      if (rosterCounts.current + rosterCounts.historical !== rosterCounts.all || page.page.total > rosterCounts[query.roster]) throw invalid();
      return { ...page, ...(rosterCounts.historical ? { rosterCounts } : {}) };
    }
  });
}
function changeSnapshot(row, key) {
  const metadata = {};
  for (const field of profileFields) {
    const value = row[`${key}_${field.toLowerCase()}`];
    if (value != null) metadata[field] = text(value);
  }
  return { displayName: text(row[`${key}_display_name`], true), status: text(row[`${key}_status`]),
    ...(Object.keys(metadata).length ? { metadata } : {}) };
}
function badFilters() { return Object.assign(new TypeError('Invalid intake list filters'), { code: 'INVALID_INPUT', status: 400 }); }
function readDeviceUserFilters(filters) {
  const query = readFilters(filters);
  const roster = filters?.roster ?? 'current';
  if (typeof roster !== 'string' || !['current', 'historical', 'all'].includes(roster)) {
    throw Object.assign(new TypeError('Invalid device roster filter'), { code: 'INVALID_INPUT', status: 400 });
  }
  return { ...query, roster };
}
function readFilters(filters = {}) {
  const number = (value, fallback, maximum) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!['string', 'number'].includes(typeof value)) throw badFilters();
    if (typeof value === 'string' && !/^[0-9]+$/.test(value)) throw badFilters();
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw badFilters();
    return result;
  };
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw badFilters();
  const search = filters.search ?? '';
  if (typeof search !== 'string' || search.length > 100) throw badFilters();
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
