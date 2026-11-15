import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestPortalService } from '../src/application/ingest-portal-service.js';

function store() {
  const page = items => ({ items, page: { number: 1, limit: 10, total: items.length, totalPages: 1 } });
  return { async getDashboard() { return { devices: { total: 1 }, people: { total: 5 }, finalEvents: { total: 33 } }; },
    async pageDevices() {}, async pagePeople() {}, async pageFinalEvents() {},
    async getIntakeCounts() { return { received: 245, deviceUsers: 129 }; },
    async pageReceivedPunches() { return page([{ id: '18446744073709551600', device_user_id: '00017',
      device_event_time_local: '2026-11-09 10:15:00', device_event_time_utc: '2026-11-09 07:15:00.123456',
      received_at: '2026-11-09 07:15:02', parse_valid: 1, processing_status: 'processed', has_final_event: '0',
      device_name: 'Test terminal', serial_number: 'TEST-1', safe_payload: { must: 'never leak' }, secret: 'never leak' }]); },
    async pageDeviceUsers() { return page([{ id: '9', device_user_id: '00017', display_name: '<script>display only</script>',
      status: 'seen', last_seen_at: '2026-11-09 07:15:02', device_name: 'Test terminal',
      mapped_person_code: null, mapped_person_name: null, password: 'never leak', card_number: 'never leak' }]); } };
}

test('ingest overview distinguishes receipts and device users from final events and people', async () => {
  const overview = await createIngestPortalService({ readStore: store() }).overview();
  assert.equal(overview.mode, 'database-ingest');
  assert.deepEqual(overview.counts, { devices: 1, people: 5, events: 33, received: 245, deviceUsers: 129 });
  assert.equal(overview.deviceConnection, 'unknown');
});

test('receipt projections preserve unsigned IDs, leading-zero users and UTC precision without raw payloads', async () => {
  const result = await createIngestPortalService({ readStore: store() }).listReceivedPunches();
  assert.equal(result.items[0].id, '18446744073709551600');
  assert.equal(result.items[0].deviceUserId, '00017');
  assert.equal(result.items[0].eventTimeUtc, '2026-11-09T07:15:00.123456Z');
  assert.equal(result.items[0].hasFinalEvent, false);
  assert.ok(!JSON.stringify(result).includes('never leak'));
  assert.equal('safe_payload' in result.items[0], false);
});

test('device identities do not become people automatically and credential metadata is excluded', async () => {
  const result = await createIngestPortalService({ readStore: store() }).listDeviceUsers();
  assert.equal(result.items[0].mappedPersonCode, null);
  assert.equal(result.items[0].displayName, '<script>display only</script>');
  assert.equal('password' in result.items[0], false);
  assert.equal('card_number' in result.items[0], false);
});

test('malformed pagination and invalid source values do not produce fabricated receipt data', async () => {
  const service = createIngestPortalService({ readStore: store() });
  for (const filters of [{ page: true }, { page: '-1' }, { limit: '101' }, { search: 'x'.repeat(101) }]) await assert.rejects(service.listDeviceUsers(filters));
  const broken = store();
  broken.pageReceivedPunches = async () => ({ items: [{}], page: { number: 1, limit: 10, total: 1, totalPages: 1 } });
  await assert.rejects(createIngestPortalService({ readStore: broken }).listReceivedPunches(), { code: 'INGEST_PORTAL_DATA_INVALID' });
});

test('current roster is the default and explicit historical/all filters reach the read store', async () => {
  const reads = store();
  const calls = [];
  const original = reads.pageDeviceUsers;
  reads.pageDeviceUsers = async query => { calls.push(query); return original(query); };
  const service = createIngestPortalService({ readStore: reads });
  await service.listDeviceUsers();
  await service.listDeviceUsers({ roster: 'historical', search: 'archived' });
  await service.listDeviceUsers({ roster: 'all' });
  assert.deepEqual(calls.map(x => x.roster), ['current', 'historical', 'all']);
  assert.equal(calls[1].search, 'archived');
  for (const roster of ['', 'CURRENT', 'absent_from_device', true, {}, "historical' OR 1=1"]) {
    await assert.rejects(service.listDeviceUsers({ roster }), { code: 'INVALID_INPUT', status: 400 });
  }
  assert.equal(calls.length, 3);
});

test('current, historical and all totals remain distinct and never expose private metadata', async () => {
  const reads = store();
  reads.getIntakeCounts = async () => ({ received: 3596, deviceUsers: 175, historicalDeviceUsers: 7, allDeviceUsers: 182 });
  const original = reads.pageDeviceUsers;
  reads.pageDeviceUsers = async query => ({ ...await original(query), rosterCounts: { current: 175, historical: 7, all: 182, secret: 'never leak' } });
  const service = createIngestPortalService({ readStore: reads });
  const overview = await service.overview();
  assert.equal(overview.counts.deviceUsers, 175);
  assert.equal(overview.counts.historicalDeviceUsers, 7);
  assert.equal(overview.counts.allDeviceUsers, 182);
  const list = await service.listDeviceUsers({ roster: 'historical' });
  assert.deepEqual(list.rosterCounts, { current: 175, historical: 7, all: 182 });
  assert.ok(!JSON.stringify(list).includes('never leak'));
  reads.pageDeviceUsers = async query => ({ ...await original(query), rosterCounts: { current: 175, historical: 7, all: 181 } });
  await assert.rejects(service.listDeviceUsers(), { code: 'INGEST_PORTAL_DATA_INVALID' });
});

test('identity receipt filter is passed as a lossless validated unsigned string', async () => {
  const reads = store();
  const base = reads.pageReceivedPunches;
  const calls = [];
  reads.pageReceivedPunches = async query => { calls.push(query); return base(query); };
  const service = createIngestPortalService({ readStore: reads });
  const deviceUserRowId = '18446744073709551615';
  await service.listReceivedPunches({ deviceUserRowId });
  assert.equal(calls[0].deviceUserRowId, deviceUserRowId);
  for (const invalid of [null, 1, '', '0', '01', '1 OR 1=1', '18446744073709551616']) {
    await assert.rejects(service.listReceivedPunches({ deviceUserRowId: invalid }), { code: 'INVALID_INPUT' });
  }
  assert.equal(calls.length, 1);
});

test('identity receipts expose the terminal code and supported status together, preserving unclassified codes', async () => {
  const reads = store();
  const base = reads.pageReceivedPunches;
  const service = createIngestPortalService({ readStore: reads });
  reads.pageReceivedPunches = async () => {
    const original = await base();
    return { ...original, items: [{ ...original.items[0], device_punch_state: '3', punch_state: 'break_in' }] };
  };
  const receipt = (await service.listReceivedPunches({ deviceUserRowId: '91' })).items[0];
  assert.equal(receipt.devicePunchState, '3');
  assert.equal(receipt.punchState, 'break_in');
  assert.ok(!('devicePunchState' in (await service.listReceivedPunches()).items[0]));
  reads.pageReceivedPunches = async () => {
    const original = await base();
    return { ...original, items: [{ ...original.items[0], device_punch_state: '9', punch_state: 'unknown' }] };
  };
  const unknown = (await service.listReceivedPunches({ deviceUserRowId: '91' })).items[0];
  assert.equal(unknown.devicePunchState, '9');
  assert.equal(unknown.punchState, null);
});

test('directory updates and additions project safe snapshots and keep the device number intact', async () => {
  const reads = store();
  reads.directorySyncEnabled = true;
  reads.pageDeviceUserChanges = async ({ kind }) => ({ items: [{ id: '18446744073709551600', device_user_row_id: '91',
    device_user_id: '00017', device_name: 'Fixture terminal', occurred_at: '2026-11-09 07:15:02.123456',
    before_display_name: null, before_status: 'seen', before_pri: '0', before_grp: '1', before_passwd: 'never leak',
    after_display_name: 'New name', after_status: 'seen', after_pri: '1', after_grp: '1', after_tz: '2',
    after_state: { Passwd: 'never leak' }, notes: 'never leak', kind }],
  page: { number: 1, limit: 10, total: 1, totalPages: 1 } });
  const service = createIngestPortalService({ readStore: reads });
  const result = await service.listDeviceUserChanges({ kind: 'updated' });
  assert.deepEqual(result.items[0], { id: '18446744073709551600', deviceUserRowId: '91', deviceUserId: '00017',
    deviceName: 'Fixture terminal', occurredAt: '2026-11-09T07:15:02.123456Z',
    before: { displayName: null, status: 'seen', metadata: { Pri: '0', Grp: '1' } },
    after: { displayName: 'New name', status: 'seen', metadata: { Pri: '1', Grp: '1', TZ: '2' } } });
  assert.equal(JSON.stringify(result).includes('never leak'), false);
  const additions = await service.listDeviceUserChanges({ kind: 'added' });
  assert.equal(additions.items[0].before, null);
  await assert.rejects(service.listDeviceUserChanges({ kind: 'archived' }), { code: 'INVALID_INPUT' });
});
