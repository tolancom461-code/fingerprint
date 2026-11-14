import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbDeviceStore } from '../src/infrastructure/storage/tidb-device-store.js';
import { toZktecoDeviceMetadata } from '../src/infrastructure/vendors/zkteco/device-options.js';

class FakePool {
  constructor() { this.calls = []; }
  async execute(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql.includes('SELECT id, vendor')) {
      return [[{ id: 7, vendor: 'zkteco', serial_number: 'SER1', status: 'active', mode: 'test', timezone: 'Asia/Riyadh' }]];
    }
    return [{ affectedRows: 1 }];
  }
}

test('device store uses vendor + serial identity and stores only sanitized metadata', async () => {
  const pool = new FakePool();
  const store = new TiDbDeviceStore(pool);
  const metadata = toZktecoDeviceMetadata({
    DeviceName: 'SpeedFace-V5L', FWVersion: 'FW1', Platform: 'ZAM230_TFT',
    OEMVendor: 'ZKTECO CO.', FaceFunOn: '1', Password: '[REDACTED]'
  });
  const row = await store.observe({
    device: { vendor: 'zkteco', serialNumber: 'SER1' },
    remoteAddress: '192.168.10.199',
    observedAt: '2026-08-30 14:00:00.000000',
    metadata
  });

  assert.equal(row.id, 7);
  const insert = pool.calls[0];
  assert.equal(insert.params[0], 'zkteco');
  assert.equal(insert.params[1], 'SER1');
  assert.equal(insert.params[2], 'SpeedFace-V5L');
  assert.equal(insert.params[7], 'FW1');
  assert.equal(String(insert.params[14]).includes('Password'), false);
});

test('safe OPERLOG users are stored without password/card/template fields', async () => {
  const pool = new FakePool();
  const store = new TiDbDeviceStore(pool);
  await store.upsertSafeUsers({
    device: { vendor: 'zkteco', serialNumber: 'SER1' },
    observedAt: '2026-08-30 14:00:00.000000',
    records: [{ kind: 'device_user', fields: { PIN: '900001', Name: 'TEST', Pri: '0', Passwd: '[REDACTED]' } }]
  });
  const insert = pool.calls.find((call) => call.sql.includes('biometric_svc_device_users'));
  assert.ok(insert);
  assert.equal(insert.params[1], '900001');
  assert.equal(insert.params[2], 'TEST');
  assert.equal(String(insert.params[3]).includes('Passwd'), false);
  assert.match(insert.sql, /status = CASE WHEN status = 'absent_from_device' THEN 'seen' ELSE status END/);
});

test('migrated USER ingestion updates only a first current identity and never resurrects a retired or reused PIN', async () => {
  const pool = new FakePool();
  const active = { id: '21', status: 'seen', identity_ended_at: null };
  const archived = { id: '10', status: 'absent_from_device', identity_ended_at: null };
  const known = new Map([['archived', [archived]], ['reused', [archived, active]], ['original', [active]]]);
  const calls = [];
  pool.getConnection = async () => ({
    async beginTransaction() { calls.push({ type: 'begin' }); },
    async commit() { calls.push({ type: 'commit' }); },
    async rollback() { calls.push({ type: 'rollback' }); },
    release() { calls.push({ type: 'release' }); },
    async execute(sql, params) {
      calls.push({ type: 'execute', sql, params });
      if (sql === 'SELECT id FROM `biometric_svc_devices` WHERE id = ? FOR UPDATE') return [[{ id: 7 }]];
      if (sql.startsWith('SELECT id, status, identity_started_at')) return [known.get(params[1]) ?? []];
      return [{ affectedRows: 1 }];
    },
  });
  const store = new TiDbDeviceStore(pool, { deviceUserIdentityEnabled: true });
  const result = await store.upsertSafeUsers({
    device: { vendor: 'zkteco', serialNumber: 'SER1' },
    observedAt: '2026-08-30 14:00:00',
    records: ['archived', 'reused', 'original', 'new'].map(PIN => ({
      kind: 'device_user', fields: { PIN, Name: `${PIN}-name`, Pri: '0', Password: 'synthetic-secret' },
    })),
  });
  assert.deepEqual(result, { deviceId: 7, userCount: 2 });
  assert.equal(calls[1].sql, 'SELECT id FROM `biometric_svc_devices` WHERE id = ? FOR UPDATE');
  const writes = calls.filter(call => /^(?:INSERT INTO|UPDATE) `biometric_svc_device_users`/.test(call.sql ?? ''));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].params[0], 'original-name');
  assert.equal(writes[0].params[4], '21');
  assert.match(writes[0].sql, /identity_ended_at IS NULL AND status <> 'absent_from_device'/);
  assert.equal(writes[1].params[1], 'new');
  assert.doesNotMatch(JSON.stringify(writes), /synthetic-secret|archived-name|reused-name/);
  assert.equal(calls.at(-2).type, 'commit');
  assert.equal(calls.at(-1).type, 'release');
});
