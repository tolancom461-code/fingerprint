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
