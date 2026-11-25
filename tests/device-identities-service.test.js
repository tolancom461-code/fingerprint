import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceIdentitiesService } from '../src/application/device-identities-service.js';

const streamId = '1f999b36-e779-429b-b1d4-c6337d1e75c9';
function identity(id = '1', changes = {}) {
  return { id, device_id: '9007199254740999', device_user_id: '60001', display_name: 'اسم الجهاز',
    device_name: 'جهاز الاختبار', serial_number: 'SYNTHETIC-001', identity_status: 'current',
    first_seen_at_utc: '2026-11-19 07:08:09.123456', last_seen_at_utc: null,
    identity_started_at_utc: null, identity_ended_at_utc: null, ...changes };
}
function service(rows, calls = []) {
  return new DeviceIdentitiesService({ streamId, readStore: { async listDeviceIdentitiesAfter(afterId, limit) {
    calls.push({ afterId, limit }); return rows.filter(row => BigInt(row.id) > BigInt(afterId)).slice(0, limit + 1);
  } } });
}

test('directory exposes safe current/historical registrations independently of PIN reuse and person mapping', async () => {
  const first = identity('9007199254740993', { identity_status: 'historical', display_name: null,
    first_seen_at_utc: null, identity_ended_at_utc: '2026-11-19 08:00:00.000001',
    password: 'do-not-export', person_code: 'unrelated-person', safe_metadata: { Verify: 'private-profile' } });
  const second = identity('18446744073709551615');
  const page = await service([first, second]).list();
  assert.equal(page.streamId, streamId);
  assert.equal(page.schemaVersion, 1);
  assert.equal(page.nextCursor, '18446744073709551615');
  assert.equal(page.hasMore, false);
  assert.deepEqual(page.items[0], { identityId: first.id, deviceId: first.device_id, deviceUserId: '60001',
    displayName: null, deviceName: first.device_name, serialNumber: first.serial_number, status: 'historical',
    firstSeenAtUtc: null, lastSeenAtUtc: null, identityStartedAtUtc: null,
    identityEndedAtUtc: '2026-11-19T08:00:00.000001Z' });
  assert.equal(page.items[1].identityId, second.id);
  assert.equal(page.items[1].deviceUserId, page.items[0].deviceUserId);
  assert.equal(page.items[1].status, 'current');
  assert.equal(page.items[1].identityStartedAtUtc, null);
  assert.doesNotMatch(JSON.stringify(page), /password|person_code|safe_metadata|private-profile/);
});

test('full paging starts from zero on refresh to observe changes to existing identities', async () => {
  const rows = [identity('9007199254740993'), identity('9007199254740994')];
  const calls = [];
  const directory = service(rows, calls);
  const first = await directory.list({ afterId: '0', limit: '1' });
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, '9007199254740993');
  const second = await directory.list({ afterId: first.nextCursor, limit: 1 });
  assert.equal(second.items[0].identityId, '9007199254740994');
  assert.equal(second.hasMore, false);
  rows[0].display_name = 'اسم محدث'; rows[0].identity_status = 'historical';
  const refreshed = await directory.list({ afterId: '0', limit: 1 });
  assert.equal(refreshed.items[0].displayName, 'اسم محدث');
  assert.equal(refreshed.items[0].status, 'historical');
  assert.equal((await directory.list({ afterId: second.nextCursor })).items.length, 0);
  assert.equal((await directory.list({ afterId: second.nextCursor })).nextCursor, second.nextCursor);
  assert.deepEqual(calls[0], { afterId: '0', limit: 1 });
});

test('directory rejects unsafe pagination before querying and never rounds unsigned identity IDs', async () => {
  const calls = [];
  const directory = service([], calls);
  for (const afterId of ['-1', ' 1', '1e2', '18446744073709551616', 9007199254740992, null]) {
    await assert.rejects(directory.list({ afterId }), { code: 'INVALID_INPUT', status: 400 });
  }
  for (const limit of [0, 501, '1.5', '', true]) await assert.rejects(directory.list({ limit }), { code: 'INVALID_INPUT' });
  await assert.rejects(directory.list({ search: 'extra' }), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 0);
  assert.equal((await directory.list({ afterId: '18446744073709551615', limit: 500 })).nextCursor, '18446744073709551615');
});

test('malformed directory data fails safely without fabricating dates, names, identities or statuses', async () => {
  for (const changes of [
    { device_id: 9007199254740992 }, { identity_status: 'deleted' }, { device_name: null },
    { display_name: { password: 'private' } }, { display_name: 'bad\u0000name' },
    { first_seen_at_utc: '2026-02-30 00:00:00' }, { identity_started_at_utc: '0000-00-00 00:00:00' },
    { last_seen_at_utc: new Date() }, { serial_number: null },
  ]) await assert.rejects(service([identity('1', changes)]).list(), { code: 'DEVICE_IDENTITIES_DATA_INVALID' });
  const directory = new DeviceIdentitiesService({ streamId, readStore: { async listDeviceIdentitiesAfter() {
    throw new Error('PRIVATE-database-password');
  } } });
  await assert.rejects(directory.list(), error => error.code === 'DEVICE_IDENTITIES_READ_FAILED' && !error.message.includes('PRIVATE'));
});

test('unordered or repeated rows cannot advance the directory cursor', async () => {
  for (const rows of [[identity('2'), identity('1')], [identity('1'), identity('1')]]) {
    const directory = new DeviceIdentitiesService({ streamId, readStore: { async listDeviceIdentitiesAfter() { return rows; } } });
    await assert.rejects(directory.list(), { code: 'DEVICE_IDENTITIES_DATA_INVALID' });
  }
  assert.throws(() => new DeviceIdentitiesService({ streamId: 'invalid', readStore: {} }), TypeError);
});
