import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbIngestReadStore } from '../src/infrastructure/storage/tidb-ingest-read-store.js';

function fixture({ archived = 7, current = 175 } = {}) {
  const calls = [];
  const store = new TiDbIngestReadStore({ async execute(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('AS received')) return [[{ received: '3596', device_users: String(current),
      historical_device_users: String(archived), all_device_users: String(current + archived) }]];
    if (sql.includes('AS current_device_users')) return [[{ current_device_users: String(current),
      historical_device_users: String(archived), all_device_users: String(current + archived) }]];
    const historical = sql.includes("u.status = 'absent_from_device'");
    const currentOnly = sql.includes("u.status <> 'absent_from_device'");
    if (sql.startsWith('SELECT COUNT')) return [[{ total: String(historical ? archived : currentOnly ? current : current + archived) }]];
    return [[{ id: historical ? '21' : '20', device_user_id: historical ? 'OLD-PIN' : 'CURRENT-PIN',
      status: historical ? 'absent_from_device' : 'seen', mapped_person_code: 'SYNTHETIC-WORKER', mapped_person_name: 'Synthetic person' }]];
  } });
  return { store, calls };
}

test('current count excludes archived identities while historical and retained totals stay explicit', async () => {
  const { store, calls } = fixture();
  assert.deepEqual(await store.getIntakeCounts(), { received: 3596, deviceUsers: 175, historicalDeviceUsers: 7, allDeviceUsers: 182 });
  assert.ok(calls.every(call => /^SELECT\b/.test(call.sql)));
  assert.ok(!calls.some(call => /DELETE|UPDATE|INSERT/.test(call.sql)));
});

test('no historical identities preserves the previous overview and page response shapes', async () => {
  const { store } = fixture({ archived: 0, current: 129 });
  assert.deepEqual(await store.getIntakeCounts(), { received: 3596, deviceUsers: 129 });
  const page = await store.pageDeviceUsers({ page: 1, limit: 10, search: '' });
  assert.deepEqual(Object.keys(page).sort(), ['items', 'page']);
  assert.equal(page.page.total, 129);
});

test('default list contains current users; historical records retain their worker association', async () => {
  const { store, calls } = fixture();
  const current = await store.pageDeviceUsers({ page: 1, limit: 10, search: '' });
  const historical = await store.pageDeviceUsers({ page: 1, limit: 10, search: '', roster: 'historical' });
  const all = await store.pageDeviceUsers({ page: 1, limit: 10, search: '', roster: 'all' });
  assert.deepEqual([current.page.total, historical.page.total, all.page.total], [175, 7, 182]);
  assert.equal(current.items[0].status, 'seen');
  assert.equal(historical.items[0].status, 'absent_from_device');
  assert.equal(historical.items[0].mapped_person_code, 'SYNTHETIC-WORKER');
  assert.deepEqual(all.rosterCounts, { current: 175, historical: 7, all: 182 });
  const itemQueries = calls.filter(call => /SELECT u\.id/.test(call.sql));
  assert.match(itemQueries[0].sql, /u\.status <> 'absent_from_device'/);
  assert.match(itemQueries[1].sql, /u\.status = 'absent_from_device'/);
  assert.doesNotMatch(itemQueries[2].sql, /u\.status [=<>]/);
});

test('search is parameterized in the selected roster and invalid scope never sends SQL', async () => {
  const { store, calls } = fixture();
  const search = "%' OR 1=1 --";
  await store.pageDeviceUsers({ page: 2, limit: 10, search, roster: 'historical' });
  for (const call of calls.filter(call => /LIKE/.test(call.sql))) {
    assert.match(call.sql, /u\.status = 'absent_from_device' AND \(/);
    assert.ok(!call.sql.includes(search));
    assert.equal(call.params.length, 4);
  }
  const count = calls.length;
  for (const roster of ['', true, 'not-current', "all' OR 1=1 --"]) {
    await assert.rejects(store.pageDeviceUsers({ page: 1, limit: 10, search: '', roster }), { code: 'INVALID_INPUT' });
  }
  assert.equal(calls.length, count);
});
