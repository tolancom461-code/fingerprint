import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbIngestReadStore } from '../src/infrastructure/storage/tidb-ingest-read-store.js';

test('intake list pagination does not bind unsupported floating-point LIMIT values on TiDB', async () => {
  const calls = [];
  const store = new TiDbIngestReadStore({ async execute(sql, params = []) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT COUNT')) return [[{ total: '0', current_device_users: '0', historical_device_users: '0', all_device_users: '0' }]];
    return [[]];
  } });
  for (const method of ['pageReceivedPunches', 'pageDeviceUsers']) {
    const result = await store[method]({ page: 2, limit: 10, search: "%' OR 1=1 --" });
    assert.equal(result.page.total, 0);
  }
  const pages = calls.filter(call => !call.sql.startsWith('SELECT COUNT'));
  assert.equal(pages.length, 2);
  for (const call of pages) {
    assert.match(call.sql, /LIMIT 10 OFFSET 10$/);
    assert.ok(call.params.every(value => typeof value === 'string'));
    assert.ok(!call.sql.includes("OR 1=1 --"));
  }
});

test('unsafe pagination fails before sending any SQL to the database', async () => {
  let calls = 0;
  const store = new TiDbIngestReadStore({ async execute() { calls++; throw new Error('must not run'); } });
  for (const method of ['pageReceivedPunches', 'pageDeviceUsers']) {
    for (const change of [{ page: 0 }, { page: '1;DROP' }, { limit: '10' }, { limit: 101 }, { page: 1000001 }]) {
      await assert.rejects(store[method]({ page: 1, limit: 10, search: '', ...change }), { code: 'INVALID_INPUT' });
    }
  }
  assert.equal(calls, 0);
});

test('historical intake filters by the exact unsigned identity row, not a reused device number', async () => {
  const calls = [];
  const pool = { async execute(sql, params) {
    calls.push({ sql, params });
    return [sql.startsWith('SELECT COUNT') ? [{ total: '0' }] : []];
  } };
  const query = { page: 1, limit: 10, search: '', deviceUserRowId: '18446744073709551600' };
  await assert.rejects(new TiDbIngestReadStore(pool).pageReceivedPunches(query), { code: 'INVALID_INPUT' });
  const store = new TiDbIngestReadStore(pool, { deviceUserIdentityEnabled: true });
  await assert.rejects(store.pageReceivedPunches({ ...query, deviceUserRowId: '18446744073709551616' }), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 0);
  await store.pageReceivedPunches(query);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.sql, /WHERE p\.device_user_row_id = CAST\(\? AS UNSIGNED\)/);
    assert.deepEqual(call.params, [query.deviceUserRowId]);
    assert.doesNotMatch(call.sql, /p\.device_user_id\s*=/);
  }
});

test('identity history reads original status, orders by device time, and recovers the six known device states', async () => {
  const terminal = { serial_number: 'AJE1261900133', punch_vendor: 'zkteco', punch_state: null };
  const states = ['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out'];
  const rows = states.map((_, index) => ({ ...terminal, device_punch_state: String(index) }));
  rows.push({ ...terminal, device_punch_state: '9', punch_state: 'check_in' },
    { ...terminal, serial_number: 'UNVERIFIED', device_punch_state: '0' });
  const store = new TiDbIngestReadStore({ async execute(sql) {
    if (sql.startsWith('SELECT COUNT')) return [[{ total: '8' }]];
    assert.match(sql, /p\.raw_status AS device_punch_state, p\.punch_state/);
    assert.match(sql, /ORDER BY p\.device_event_time_local DESC,p\.id DESC/);
    return [rows];
  } }, { deviceUserIdentityEnabled: true });
  const result = await store.pageReceivedPunches({ page: 1, limit: 10, deviceUserRowId: '91' });
  assert.deepEqual(result.items.map(row => row.punch_state), [...states, null, null]);
  assert.deepEqual(result.items.map(row => row.device_punch_state), ['0', '1', '2', '3', '4', '5', '9', '0']);
});

test('directory history reads only whitelisted change snapshot fields and separates additions from edits', async () => {
  const calls = [];
  const store = new TiDbIngestReadStore({ async execute(sql, params) {
    calls.push({ sql, params });
    return [sql.startsWith('SELECT COUNT') ? [{ total: '0' }] : []];
  } }, { directorySyncEnabled: true });
  await store.pageDeviceUserChanges({ page: 2, limit: 10, search: '100%', kind: 'updated' });
  assert.match(calls[0].sql, /a\.entity_type = 'device_user' AND a\.action_type = \?/);
  assert.match(calls[0].sql, /ORDER BY a\.occurred_at DESC,a\.id DESC LIMIT 10 OFFSET 10$/);
  assert.match(calls[0].sql, /AS before_display_name.*before_status/s);
  assert.match(calls[0].sql, /\$\.metadata\.Pri.*AS before_pri/s);
  assert.doesNotMatch(calls[0].sql, /(?:SELECT|,)\s+a\.(?:before|after)_state\b|\$\.metadata\.Passwd/);
  assert.deepEqual(calls[0].params, ['device_user_updated', ...Array(4).fill('%100!%%')]);
  await store.pageDeviceUserChanges({ page: 1, limit: 10, search: '', kind: 'added' });
  assert.deepEqual(calls[2].params, ['device_user_added']);
  await assert.rejects(store.pageDeviceUserChanges({ page: 1, limit: 10, search: '', kind: 'archived' }), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 4);
});
