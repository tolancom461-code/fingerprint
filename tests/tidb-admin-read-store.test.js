import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbAdminReadStore } from '../src/infrastructure/storage/tidb-admin-read-store.js';

function poolWith(responses) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) {
      calls.push({ sql, params });
      const next = responses.shift();
      if (!next) throw new Error('unexpected query');
      return [next, []];
    }
  };
}

test('unmapped users include a safe same-code person suggestion without auto-mapping it', async () => {
  const pool = poolWith([[{
    id: 7, device_id: 1, device_user_id: '175', display_name: null, status: 'seen',
    suggested_person_id: 9, suggested_person_code: '175', suggested_person_name: 'Ahmed', suggested_person_status: 'active'
  }]]);
  const store = new TiDbAdminReadStore(pool);
  const rows = await store.listUnmappedDeviceUsers();
  assert.equal(rows[0].suggested_person_id, 9);
  assert.match(pool.calls[0].sql, /LEFT JOIN `biometric_svc_people` p ON p\.person_code = u\.device_user_id/);
  assert.match(pool.calls[0].sql, /WHERE m\.id IS NULL/);
});

test('targeted issue retry query is limited to unmapped_device_user for one device-user row', async () => {
  const pool = poolWith([[{ source_punch_id: 60001 }, { source_punch_id: 60002 }]]);
  const store = new TiDbAdminReadStore(pool);
  const ids = await store.listOpenUnmappedPunchIdsForDeviceUserRowId(7);
  assert.deepEqual(ids, [60001, 60002]);
  assert.match(pool.calls[0].sql, /i\.issue_type = 'unmapped_device_user'/);
  assert.deepEqual(pool.calls[0].params, [7]);
  assert.match(pool.calls[0].sql, /LIMIT 100/);
  assert.doesNotMatch(pool.calls[0].sql, /LIMIT \?/);
});


test('admin read pagination uses validated literal limits instead of prepared LIMIT parameters for TiDB compatibility', async () => {
  const pool = poolWith([
    [], // devices
    [], // people
    [], // unmapped
    [], // issues
    []  // events
  ]);
  const store = new TiDbAdminReadStore(pool);
  await store.listDevices({ limit: 17 });
  await store.listPeople({ limit: 18 });
  await store.listUnmappedDeviceUsers({ limit: 19 });
  await store.listOpenIssues({ limit: 20 });
  await store.listRecentFinalEvents({ limit: 21 });
  for (const call of pool.calls) {
    assert.doesNotMatch(call.sql, /LIMIT \?/);
  }
  assert.match(pool.calls[0].sql, /LIMIT 17/);
  assert.match(pool.calls[1].sql, /LIMIT 18/);
  assert.match(pool.calls[2].sql, /LIMIT 19/);
  assert.match(pool.calls[3].sql, /LIMIT 20/);
  assert.match(pool.calls[4].sql, /LIMIT 21/);
});

test('filtered final-events page uses safe literal pagination and parameterized filters', async () => {
  const pool = poolWith([
    [{ total: 2 }],
    [{ id: 9, final_event_uuid: '11111111-1111-4111-8111-111111111111', person_code: '900003' }]
  ]);
  const store = new TiDbAdminReadStore(pool);
  const result = await store.pageFinalEvents({
    page: 2, limit: 25, search: '900003', eventType: 'check_out', deviceId: 1,
    verificationMethod: 'fingerprint', from: '2026-09-01', to: '2026-09-03'
  });
  assert.equal(result.page.number, 2);
  assert.equal(result.page.total, 2);
  assert.match(pool.calls[1].sql, /LIMIT 25 OFFSET 25/);
  assert.doesNotMatch(pool.calls[1].sql, /LIMIT \?/);
  assert.match(pool.calls[1].sql, /f\.event_time_local >= \?/);
  assert.match(pool.calls[1].sql, /f\.event_time_local < \?/);
  assert.deepEqual(pool.calls[1].params, [
    '%900003%', '%900003%', 'check_out', 'fingerprint', 1,
    '2026-09-01 00:00:00', '2026-09-04 00:00:00'
  ]);
});

test('people pagination supports mapping and device filters without exposing main-app identity', async () => {
  const pool = poolWith([
    [{ total: 1 }],
    [{ id: 3, person_code: '900003', display_name: 'Test', status: 'active', mapped_device_users: '1' }]
  ]);
  const store = new TiDbAdminReadStore(pool);
  const result = await store.pagePeople({ mapping: 'mapped', deviceId: 1, search: '900', page: 1, limit: 20 });
  assert.equal(result.items[0].mapped_device_users, 1);
  assert.match(pool.calls[0].sql, /EXISTS \(SELECT 1 FROM `biometric_svc_person_device_users` mx/);
  assert.match(pool.calls[0].sql, /du\.device_id = \?/);
  assert.equal(pool.calls[0].sql.includes('worker_id'), false);
});

test('operational reports stay inside biometric tables and use an inclusive selected end day', async () => {
  const pool = poolWith([
    [{ canonical_punches: 5, final_events: 5, issues_in_period: 1, open_issues_now: 0, unmapped_now: 0 }],
    [{ id: 1, final_events_in_period: '5', open_issues: '0', unmapped_users: '0' }],
    [{ people_total: 3, active_people: 3, device_users_total: 3, active_mappings: 3, unmapped_device_users: 0, inactive_mappings: 0, people_without_devices: 0, people_multi_device: 0 }],
    [{ total: 1, resolved: 1, open: 0 }],
    []
  ]);
  const store = new TiDbAdminReadStore(pool);
  const report = await store.getOperationalReports({ from: '2026-09-02', to: '2026-09-02' });
  assert.equal('finalization_rate' in report.systemHealth, false);
  assert.equal(report.devices[0].final_events_in_period, 5);
  assert.match(pool.calls[0].sql, /automatic_finalization_pending/);
  assert.match(pool.calls[3].sql, /automatic_finalization_pending/);
  assert.match(pool.calls[4].sql, /automatic_finalization_pending/);
  assert.equal(report.mapping.active_mappings, 3);
  assert.deepEqual(pool.calls[0].params, [
    '2026-09-02 00:00:00', '2026-09-03 00:00:00',
    '2026-09-02 00:00:00', '2026-09-03 00:00:00',
    '2026-09-02 00:00:00', '2026-09-03 00:00:00'
  ]);
  for (const call of pool.calls) {
    assert.equal(/workers|attendance_events|payroll|finance/i.test(call.sql), false);
  }
});

test('admin date filters reject invalid calendar ranges before querying TiDB', async () => {
  const pool = poolWith([]);
  const store = new TiDbAdminReadStore(pool);
  await assert.rejects(() => store.pageFinalEvents({ from: '2026-02-30' }), /valid date/);
  await assert.rejects(() => store.pageIssues({ from: '2026-09-03', to: '2026-09-02' }), /from must be on or before to/);
  assert.equal(pool.calls.length, 0);
});
