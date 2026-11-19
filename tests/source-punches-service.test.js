import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SourcePunchesService } from '../src/application/source-punches-service.js';

const streamId = '1f999b36-e779-429b-b1d4-c6337d1e75c9';
const states = ['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out'];
function punch(id = '1', raw = '0', changes = {}) {
  return { id, event_key: createHash('sha256').update(id).digest('hex'), device_id: '9007199254740999',
    device_user_id: '60001', device_user_row_id: null, punch_state: states[Number(raw)], raw_status: raw,
    device_event_time_utc: '2026-11-19 07:08:09.123456', ...changes };
}
function service(rows, calls = []) {
  return new SourcePunchesService({ streamId, readStore: { async listSourcePunchesAfter(afterId, limit) {
    calls.push({ afterId, limit }); return rows;
  } } });
}

test('received contract includes all six states and exact identities but no mutable mapping or names', async () => {
  const rows = states.map((_, index) => punch(String(index + 1), String(index), {
    device_user_row_id: index ? '18446744073709551615' : null,
    display_name: 'Mutable name', person_code: 'MUTABLE-PERSON', safe_payload: { password: 'never export' },
  }));
  const page = await service(rows).list();
  assert.equal(page.schemaVersion, 1);
  assert.equal(page.streamId, streamId);
  assert.equal(page.nextCursor, '6');
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.items.map(item => item.eventType), states);
  assert.deepEqual(page.items.map(item => item.rawState), ['0', '1', '2', '3', '4', '5']);
  assert.equal(page.items[0].sourceIdentityId, null);
  assert.equal(page.items[1].sourceIdentityId, '18446744073709551615');
  assert.deepEqual(page.items[0], { sourceEventId: rows[0].event_key, sourceDeviceId: '9007199254740999',
    sourceDeviceUserId: '60001', sourceIdentityId: null, eventType: 'check_in', rawState: '0',
    eventTimeUtc: '2026-11-19T07:08:09.123456Z' });
  for (const item of page.items) assert.deepEqual(Object.keys(item), Object.keys(page.items[0]));
});

test('cursor stays an exact unsigned bigint, limit+1 lookahead never consumes the next item', async () => {
  const calls = [];
  const rows = [punch('9007199254740993'), punch('18446744073709551614'), punch('18446744073709551615')];
  const reader = service(rows, calls);
  const first = await reader.list({ afterId: '9007199254740992', limit: '2' });
  assert.equal(first.nextCursor, '18446744073709551614');
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(await reader.list({ afterId: '9007199254740992', limit: 2 }), first);
  assert.deepEqual(calls[0], { afterId: '9007199254740992', limit: 2 });
  assert.equal((await service([]).list({ afterId: '18446744073709551615' })).nextCursor, '18446744073709551615');
});

test('invalid pagination is rejected before the store is called', async () => {
  const calls = [];
  const reader = service([], calls);
  for (const afterId of ['', '-1', ' 1', '1e2', '1 OR 1=1', '18446744073709551616', 9007199254740992, null, {}]) {
    await assert.rejects(reader.list({ afterId }), { code: 'INVALID_INPUT', status: 400 });
  }
  for (const limit of [0, 501, '1.5', '', true, {}, null]) {
    await assert.rejects(reader.list({ limit }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(reader.list(null), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 0);
});

test('UTC serialization preserves microseconds, validates calendar dates and never depends on process TZ', async () => {
  for (const [input, expected] of [
    ['2026-11-19 07:08:09', '2026-11-19T07:08:09.000000Z'],
    ['2026-11-19T07:08:09.12Z', '2026-11-19T07:08:09.120000Z'],
    ['2026-11-19 07:08:09.123456', '2026-11-19T07:08:09.123456Z'],
  ]) assert.equal((await service([punch('1', '0', { device_event_time_utc: input })]).list()).items[0].eventTimeUtc, expected);
  for (const value of ['2026-02-30 01:00:00', '0000-00-00 00:00:00', '2026-11-19T07:08:09+03:00', new Date(), null]) {
    await assert.rejects(service([punch('1', '0', { device_event_time_utc: value })]).list(), { code: 'SOURCE_PUNCHES_DATA_INVALID' });
  }
});

test('invalid stored states, precision loss, ordering or oversized pages fail without returning a cursor', async () => {
  for (const rows of [
    [punch('1', '2', { punch_state: 'check_in' })], [punch('1', '9')],
    [punch('1', '0', { device_id: 9007199254740992 })], [punch('1', '0', { event_key: 'not-an-event-key' })],
    [punch('2'), punch('1')], [punch('1'), punch('1')], [punch('1'), punch('2'), punch('3')],
  ]) await assert.rejects(service(rows).list({ limit: 1 }), { code: 'SOURCE_PUNCHES_DATA_INVALID' });
});

test('configuration and downstream read failures do not disclose database details', async () => {
  assert.throws(() => new SourcePunchesService({ streamId: 'missing', readStore: {} }), TypeError);
  const reader = new SourcePunchesService({ streamId, readStore: { async listSourcePunchesAfter() {
    throw new Error('mysql://secret-credentials@host');
  } } });
  await assert.rejects(reader.list(), error => error.code === 'SOURCE_PUNCHES_READ_FAILED'
    && !error.message.includes('secret'));
});
