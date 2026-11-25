const MAX_ID = 18446744073709551615n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read-only metadata pages. Callers refresh from zero to observe mutable names/status. */
export class DeviceIdentitiesService {
  constructor({ readStore, streamId } = {}) {
    if (typeof readStore?.listDeviceIdentitiesAfter !== 'function') throw new TypeError('A device identity read store is required');
    if (typeof streamId !== 'string' || !UUID.test(streamId)) throw new TypeError('A device identity stream UUID is required');
    this.readStore = readStore;
    this.streamId = streamId;
  }

  async list(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['afterId', 'limit'].includes(key))) throw invalidInput();
    const cursor = cursorValue(options.afterId === undefined ? '0' : options.afterId);
    const limit = limitValue(options.limit === undefined ? 100 : options.limit);
    let rows;
    try { rows = await this.readStore.listDeviceIdentitiesAfter(cursor, limit); }
    catch { throw Object.assign(new Error('Device identities could not be read'), { code: 'DEVICE_IDENTITIES_READ_FAILED' }); }
    if (!Array.isArray(rows) || rows.length > limit + 1) throw invalidData();
    let previous = BigInt(cursor);
    for (const row of rows) {
      const id = identityId(row?.id);
      if (BigInt(id) <= previous) throw invalidData();
      previous = BigInt(id);
    }
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { schemaVersion: 1, streamId: this.streamId, items: page.map(publicIdentity),
      nextCursor: page.length ? identityId(page.at(-1).id) : cursor, hasMore };
  }
}

function publicIdentity(row) {
  if (!['current', 'historical'].includes(row.identity_status)) throw invalidData();
  return {
    identityId: identityId(row.id),
    deviceId: identityId(row.device_id),
    deviceUserId: text(row.device_user_id, 128),
    displayName: row.display_name === null ? null : text(row.display_name, 255, true),
    deviceName: text(row.device_name, 255),
    serialNumber: text(row.serial_number, 128),
    status: row.identity_status,
    firstSeenAtUtc: nullableUtc(row.first_seen_at_utc),
    lastSeenAtUtc: nullableUtc(row.last_seen_at_utc),
    // Unknown enrollment bounds stay unknown; firstSeen is not an enrollment date.
    identityStartedAtUtc: nullableUtc(row.identity_started_at_utc),
    identityEndedAtUtc: nullableUtc(row.identity_ended_at_utc),
  };
}

function cursorValue(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)
    || (typeof value === 'number' && !Number.isSafeInteger(value))) throw invalidInput();
  const text = String(value);
  if (!/^[0-9]{1,20}$/.test(text) || BigInt(text) > MAX_ID) throw invalidInput();
  return BigInt(text).toString();
}
function limitValue(value) {
  if (!['string', 'number'].includes(typeof value)
    || (typeof value === 'string' && !/^[0-9]+$/.test(value))) throw invalidInput();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 500) throw invalidInput();
  return number;
}
function identityId(value) {
  if (!['string', 'number', 'bigint'].includes(typeof value)
    || (typeof value === 'number' && !Number.isSafeInteger(value))) throw invalidData();
  const text = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > MAX_ID) throw invalidData();
  return text;
}
function text(value, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || [...value].length > maximum
    || /[\u0000-\u001f\u007f]/.test(value) || /\p{Surrogate}/u.test(value)) throw invalidData();
  return value;
}
function nullableUtc(value) {
  if (value === null) return null;
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
  return Object.assign(new TypeError('Invalid device identity pagination'), { code: 'INVALID_INPUT', status: 400 });
}
function invalidData() {
  return Object.assign(new Error('Device identity data is invalid'), { code: 'DEVICE_IDENTITIES_DATA_INVALID' });
}
