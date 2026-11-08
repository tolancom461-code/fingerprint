export class FinalEventsReadService {
  constructor({ readStore }) { this.readStore = readStore; }

  async list({ afterId = '0', limit = 100 } = {}) {
    const cursor = normalizeCursor(afterId);
    const pageSize = normalizeLimit(limit);
    const rows = await this.readStore.listFinalEventsAfter(cursor, pageSize);
    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = pageRows.map(publicEvent);
    const nextAfterId = pageRows.length > 0 ? String(pageRows.at(-1).id) : cursor;

    return {
      apiVersion: 'v1',
      items,
      page: {
        afterId: cursor,
        nextAfterId,
        limit: pageSize,
        hasMore
      }
    };
  }

  async getByUuid(finalEventUuid) {
    const row = await this.readStore.getFinalEventByUuid(finalEventUuid);
    if (!row) {
      const error = new Error('Final event not found');
      error.code = 'FINAL_EVENT_NOT_FOUND';
      throw error;
    }
    return { apiVersion: 'v1', event: publicEvent(row) };
  }
}

function publicEvent(row) {
  return {
    eventId: String(row.final_event_uuid),
    personCode: String(row.person_code),
    eventType: String(row.event_type),
    eventTimeUtc: utcTimestamp(row.event_time_utc),
    eventTimeLocal: localTimestamp(row.event_time_local),
    eventTimezone: String(row.event_timezone),
    verificationMethod: row.verification_method == null ? null : String(row.verification_method),
    finalizationVersion: String(row.finalization_version)
  };
}

function normalizeCursor(value) {
  const text = String(value ?? '0').trim();
  if (!/^\d+$/.test(text)) throw new TypeError('after_id must be a non-negative integer');
  const n = BigInt(text);
  if (n > 9223372036854775807n) throw new TypeError('after_id is out of range');
  return n.toString();
}

function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new TypeError('limit must be an integer between 1 and 500');
  return n;
}

function utcTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(text)) throw new TypeError('invalid UTC event time');
  return `${text.replace(' ', 'T')}Z`;
}

function localTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(text)) throw new TypeError('invalid local event time');
  return text.replace(' ', 'T');
}
