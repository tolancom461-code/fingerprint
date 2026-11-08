import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbPeopleStore } from '../src/infrastructure/storage/tidb-people-store.js';

function fakePool() {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT')) return [{ insertId: 12 }];
      if (sql.includes('WHERE id = ?')) return [[{ id: 12, person_code: '175', display_name: 'Ahmed', status: 'active' }]];
      if (sql.includes('WHERE person_code = ?')) return [[{ id: 12, person_code: params[0], display_name: 'Ahmed', status: 'active' }]];
      return [[{ id: 12, person_code: '175', display_name: 'Ahmed', status: 'active' }]];
    }
  };
}

test('TiDbPeopleStore creates a sanitized person row and reads it back', async () => {
  const pool = fakePool();
  const store = new TiDbPeopleStore(pool);
  const row = await store.createPerson({ personCode: ' 175 ', displayName: ' Ahmed ', notes: ' note ' });
  assert.equal(row.id, 12);
  assert.deepEqual(pool.calls[0].params, ['175', 'Ahmed', 'active', 'note']);
});

test('TiDbPeopleStore rejects empty person code and display name', async () => {
  const store = new TiDbPeopleStore(fakePool());
  await assert.rejects(store.createPerson({ personCode: '', displayName: 'Ahmed' }), /personCode is required/);
  await assert.rejects(store.createPerson({ personCode: '1', displayName: '' }), /displayName is required/);
});

test('TiDbPeopleStore converts database duplicate to stable conflict code', async () => {
  const pool = { async execute() { const e = new Error('duplicate'); e.code = 'ER_DUP_ENTRY'; throw e; } };
  const store = new TiDbPeopleStore(pool);
  await assert.rejects(store.createPerson({ personCode: '175', displayName: 'Ahmed' }), (e) => e.code === 'PERSON_CODE_CONFLICT');
});


test('TiDbPeopleStore pagination uses validated SQL integer literals for TiDB compatibility', async () => {
  const pool = fakePool();
  const store = new TiDbPeopleStore(pool);
  await store.listPeople({ status: 'active', limit: 25, offset: 50 });
  const call = pool.calls.at(-1);
  assert.match(call.sql, /LIMIT 25 OFFSET 50/);
  assert.doesNotMatch(call.sql, /LIMIT \?|OFFSET \?/);
  assert.deepEqual(call.params, ['active']);
});
