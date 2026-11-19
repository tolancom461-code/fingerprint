const MAX_ID = 18446744073709551615n;
const STATES = ['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable received-punch projection only. No identity resolution, finalization or writes. */
export class SourcePunchesService {
  constructor({ readStore, streamId } = {}) {
    if (typeof readStore?.listSourcePunchesAfter !== 'function') throw new TypeError('A source punch read store is required');
    if (typeof streamId !== 'string' || !UUID.test(streamId)) throw new TypeError('A source stream UUID is required');
    this.readStore = readStore;
    this.streamId = streamId;
  }

  async list(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['afterId', 'limit'].includes(key))) throw invalidInput();
    const cursor = inputCursor(options.afterId === undefined ? '0' : options.afterId);
    const limit = inputLimit(options.limit === undefined ? 100 : options.limit);
    let rows;
    try { rows = await this.readStore.listSourcePunchesAfter(cursor, limit); }
    catch { throw Object.assign(new Error('Source punches could not be read'), { code: 'SOURCE_PUNCHES_READ_FAILED' }); }
    if (!Array.isArray(rows) || rows.length > limit + 1) throw invalidData();
    let previous = BigInt(cursor);
    for (const row of rows) {
      const id = sourceId(row?.id);
      if (BigInt(id) <= previous) throw invalidData();
      previous = BigInt(id);
    }
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      schemaVersion: 1,
      streamId: this.streamId,
      items: page.map(publicPunch),
      nextCursor: page.length ? sourceId(page.at(-1).id) : cursor,
      hasMore,
    };
  }
}

function publicPunch(row) {
  const rawState = row.raw_status;
  if (typeof rawState !== 'string' || !/^[0-5]$/.test(rawState)
    || row.punch_state !== STATES[Number(rawState)]) throw invalidData();
  if (typeof row.event_key !== 'string' || !/^[0-9a-f]{64}$/i.test(row.event_key)) throw invalidData();
  if (typeof row.device_user_id !== 'string' || !row.device_user_id.length
    || row.device_user_id.length > 128 || /[\u0000-\u001f\u007f]/.test(row.device_user_id)) throw invalidData();
  return {
    sourceEventId: row.event_key,
    sourceDeviceId: sourceId(row.device_id),
    sourceDeviceUserId: row.device_user_id,
    // Historical rows remain unresolved. Never infer a registration from its PIN.
    sourceIdentityId: row.device_user_row_id == null ? null : sourceId(row.device_user_row_id),
    eventType: row.punch_state,
    rawState,
    eventTimeUtc: utcTimestamp(row.device_event_time_utc),
  };
}

function inputCursor(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)
    || (typeof value === 'number' && !Number.isSafeInteger(value))) throw invalidInput();
  const text = String(value);
  if (!/^[0-9]{1,20}$/.test(text) || BigInt(text) > MAX_ID) throw invalidInput();
  return BigInt(text).toString();
}

function inputLimit(value) {
  if (!['string', 'number'].includes(typeof value)
    || (typeof value === 'string' && !/^[0-9]+$/.test(value))) throw invalidInput();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw invalidInput();
  return limit;
}

function sourceId(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)
    || (typeof value === 'number' && !Number.isSafeInteger(value))) throw invalidData();
  const text = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > MAX_ID) throw invalidData();
  return text;
}

function utcTimestamp(value) {
  if (typeof value !== 'string') throw invalidData();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(value);
  if (!match || Number(match[1].slice(0, 4)) < 1) throw invalidData();
  const seconds = `${match[1]}T${match[2]}`;
  const fraction = (match[3] ?? '').padEnd(6, '0');
  const instant = new Date(`${seconds}.${fraction.slice(0, 3)}Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 19) !== seconds) throw invalidData();
  return `${seconds}.${fraction}Z`;
}

function invalidInput() {
  return Object.assign(new TypeError('Invalid source punch pagination'), { code: 'INVALID_INPUT', status: 400 });
}
function invalidData() {
  return Object.assign(new Error('Source punch data is invalid'), { code: 'SOURCE_PUNCHES_DATA_INVALID' });
}
