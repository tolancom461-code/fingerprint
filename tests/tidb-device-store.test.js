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
});
