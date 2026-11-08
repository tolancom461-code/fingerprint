import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbPersonDirectoryReadStore } from '../src/infrastructure/storage/tidb-person-directory-read-store.js';

function fakePool(rows = []) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      return [rows];
    }
  };
}

test('TiDB person directory reads only safe columns and defaults to active people', async () => {
  const pool = fakePool([{ person_code: '900001', display_name: 'Ahmed', status: 'active' }]);
  const store = new TiDbPersonDirectoryReadStore(pool);
  const rows = await store.listPeople({ limit: 2 });
  assert.equal(rows.length, 1);
  assert.match(pool.calls[0].sql, /SELECT person_code, display_name, status/);
  assert.match(pool.calls[0].sql, /WHERE status = \?/);
  assert.match(pool.calls[0].sql, /ORDER BY person_code ASC/);
  assert.match(pool.calls[0].sql, /LIMIT 3/);
  assert.deepEqual(pool.calls[0].params, ['active']);
  for (const forbidden of ['notes', 'created_at', 'updated_at', 'person_id', 'device_user']) {
    assert.equal(pool.calls[0].sql.includes(forbidden), false);
  }
});

test('TiDB person directory parameterizes search/status/cursor and escapes LIKE wildcards', async () => {
  const pool = fakePool([]);
  const store = new TiDbPersonDirectoryReadStore(pool);
  await store.listPeople({ search: '90%_x', status: 'inactive', afterCode: '900001', limit: 10 });
  const call = pool.calls[0];
  assert.match(call.sql, /status = \?/);
  assert.match(call.sql, /person_code LIKE \? OR display_name LIKE \?/);
  assert.match(call.sql, /person_code > \?/);
  assert.match(call.sql, /LIMIT 11/);
  assert.deepEqual(call.params, ['inactive', '%90\\%\\_x%', '%90\\%\\_x%', '900001']);
});

test('TiDB person directory can explicitly include all statuses', async () => {
  const pool = fakePool([]);
  const store = new TiDbPersonDirectoryReadStore(pool);
  await store.listPeople({ status: 'all', limit: 100 });
  assert.equal(pool.calls[0].sql.includes('status = ?'), false);
  assert.deepEqual(pool.calls[0].params, []);
});
