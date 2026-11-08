import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbPersonDeviceUserStore } from '../src/infrastructure/storage/tidb-person-device-user-store.js';

test('lists only unmapped device users using a left join', async () => {
  let captured = null;
  const pool = { async execute(sql, params) { captured = { sql, params }; return [[{ id: 7, device_user_id: '175' }]]; } };
  const store = new TiDbPersonDeviceUserStore(pool);
  const rows = await store.listUnmappedDeviceUsers({ limit: 25 });
  assert.equal(rows.length, 1);
  assert.match(captured.sql, /LEFT JOIN/);
  assert.match(captured.sql, /m\.id IS NULL/);
  assert.equal(captured.params, undefined);
  assert.match(captured.sql, /LIMIT 25 OFFSET 0/);
  assert.doesNotMatch(captured.sql, /LIMIT \?|OFFSET \?/);
});

test('mapping duplicate becomes a stable mapping conflict', async () => {
  const pool = { async execute() { const e = new Error('duplicate'); e.errno = 1062; throw e; } };
  const store = new TiDbPersonDeviceUserStore(pool);
  await assert.rejects(store.createMapping({ personId: 1, deviceUserRowId: 7 }), (e) => e.code === 'DEVICE_USER_MAPPING_CONFLICT');
});
