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
