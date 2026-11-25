import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbDeviceIdentitiesReadStore } from '../src/infrastructure/storage/tidb-device-identities-read-store.js';

function fixture(enabled = true) {
  const calls = [];
  const store = new TiDbDeviceIdentitiesReadStore({ async execute(sql, params) { calls.push({ sql, params }); return [[], []]; } },
    { deviceUserIdentityEnabled: enabled });
  return { store, calls };
}

test('directory store refuses the legacy schema without issuing a query', async () => {
  const { store, calls } = fixture(false);
  await assert.rejects(store.listDeviceIdentitiesAfter('0', 100), { code: 'DEVICE_IDENTITIES_UNAVAILABLE' });
  assert.equal(calls.length, 0);
});

test('directory query includes all identities and only safe device metadata with lossless cursor/time projection', async () => {
  const { store, calls } = fixture();
  await store.listDeviceIdentitiesAfter('18446744073709551614', 500);
  const { sql, params } = calls[0];
  assert.match(sql, /FROM `biometric_svc_device_users` u/);
  assert.match(sql, /LEFT JOIN `biometric_svc_devices` d ON d\.id = u\.device_id/);
  assert.match(sql, /WHERE u\.id > CAST\(\? AS DECIMAL\(20,0\)\)\s+ORDER BY u\.id ASC\s+LIMIT 501$/);
  assert.match(sql, /CAST\(u\.id AS CHAR\) AS id/);
  assert.match(sql, /CASE WHEN u\.status = 'absent_from_device' THEN 'historical' ELSE 'current' END/);
  assert.match(sql, /DATE_FORMAT\(u\.identity_started_at, '%Y-%m-%dT%H:%i:%s\.%fZ'\)/);
  assert.doesNotMatch(sql, /person|safe_metadata|metadata_schema|password|template|raw_|INSERT|UPDATE|DELETE/);
  assert.deepEqual(params, ['18446744073709551614']);
});

test('directory storage independently rejects unsafe cursors and page limits', async () => {
  const { store, calls } = fixture();
  for (const afterId of ['-1', '0;DELETE', '18446744073709551616', 9007199254740992, null]) {
    await assert.rejects(store.listDeviceIdentitiesAfter(afterId, 100), { code: 'INVALID_INPUT' });
  }
  for (const limit of [0, 501, '1.1', true]) await assert.rejects(store.listDeviceIdentitiesAfter('0', limit), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 0);
});
