import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbPunchStore } from '../src/infrastructure/storage/tidb-punch-store.js';

class FakeConnection {
  constructor({ failPunch = false, failIntent = false } = {}) { this.failPunch = failPunch; this.failIntent = failIntent; this.calls = []; }
  async beginTransaction() { this.calls.push({ type: 'begin' }); }
  async commit() { this.calls.push({ type: 'commit' }); }
  async rollback() { this.calls.push({ type: 'rollback' }); }
  release() { this.calls.push({ type: 'release' }); }
  async execute(sql, params = []) {
    this.calls.push({ type: 'execute', sql, params });
    if (this.failPunch && sql.startsWith('INSERT INTO `biometric_svc_punches`')) throw new Error('storage failed');
    if (this.failIntent && sql.startsWith('INSERT INTO `biometric_svc_finalization_issues`')) throw new Error('intent storage failed');
    return [{ affectedRows: 1, insertId: 1 }];
  }
}
class FakePool {
  constructor(connection) { this.connection = connection; this.calls = []; }
  async getConnection() { return this.connection; }
  async execute(sql, params = []) { this.calls.push({ sql, params }); return [{ affectedRows: 1 }]; }
}

function punch() {
  return {
    ingestEventId: 21, deviceId: 7, eventKey: 'a'.repeat(64), eventKeyStrategy: 'core-qualified-dedupe',
    eventKeyVersion: '1', vendorDedupeKey: 'b'.repeat(64), vendorDedupeStrategy: 'zkteco-attlog-v1',
    vendorDedupeVersion: '1', vendor: 'zkteco', serialNumber: 'SER1', deviceUserId: '900001',
    deviceEventTime: '2026-08-30 14:00:00', deviceTimezone: null, deviceEventTimeUtc: null,
    rawStatus: '0', punchState: 'check_in', rawVerify: '1', verificationMethod: 'fingerprint', workCode: '0',
    delimiter: 'tab', extraFields: ['0', '0'], wireSourceBytes: 50, wireHash: 'c'.repeat(64),
    parserVersion: 'parser-v1', receivedAt: '2026-08-30T11:00:00.000Z'
  };
}

test('TiDB punch store atomically writes canonical punch, device user and processed state', async () => {
  const connection = new FakeConnection();
  const pool = new FakePool(connection);
  const store = new TiDbPunchStore({ pool });
  const result = await store.putIfAbsent(punch());
  assert.equal(result.status, 'inserted');
  assert.equal(result.punchId, '1');
  assert.equal(connection.calls.some((c) => c.sql?.includes('biometric_svc_punches')), true);
  assert.equal(connection.calls.some((c) => c.sql?.includes('biometric_svc_device_users')), true);
  assert.equal(connection.calls.some((c) => c.sql?.includes("status = 'processed'")), true);
  assert.equal(connection.calls.some((c) => c.type === 'commit'), true);
});

test('TiDB punch store leaves durable source retryable if canonical transaction fails', async () => {
  const connection = new FakeConnection({ failPunch: true });
  const pool = new FakePool(connection);
  const store = new TiDbPunchStore({ pool, retryDelaySeconds: 45 });
  await assert.rejects(store.putIfAbsent(punch()), /storage failed/);
  assert.equal(connection.calls.some((c) => c.type === 'rollback'), true);
  assert.equal(pool.calls.some((c) => c.sql.includes('INSERT INTO `biometric_svc_event_processing`')), true);
  assert.equal(pool.calls.some((c) => c.sql.includes('ON DUPLICATE KEY UPDATE')), true);
  assert.equal(pool.calls.some((c) => c.sql.includes("status = 'retry'")), true);
  assert.equal(pool.calls.some((c) => c.sql.includes('INTERVAL 45 SECOND')), true);
});


test('automatic finalization intent is persisted atomically with a newly inserted canonical punch', async () => {
  const connection = new FakeConnection();
  const pool = new FakePool(connection);
  const store = new TiDbPunchStore({ pool });
  const result = await store.putIfAbsent(punch(), { createAutomaticFinalizationIntent: true });
  assert.equal(result.status, 'inserted');
  const intent = connection.calls.find((c) => c.sql?.startsWith('INSERT INTO `biometric_svc_finalization_issues`'));
  assert.ok(intent);
  assert.equal(intent.params[0], '1');
  assert.equal(intent.params[1], 'automatic_finalization_pending');
  assert.equal(connection.calls.findIndex((c) => c === intent) < connection.calls.findIndex((c) => c.type === 'commit'), true);
});

test('failure to persist automatic finalization intent rolls back canonical insert and leaves durable ingest retryable', async () => {
  const connection = new FakeConnection({ failIntent: true });
  const pool = new FakePool(connection);
  const store = new TiDbPunchStore({ pool, retryDelaySeconds: 30 });
  await assert.rejects(
    store.putIfAbsent(punch(), { createAutomaticFinalizationIntent: true }),
    /intent storage failed/
  );
  assert.equal(connection.calls.some((c) => c.type === 'rollback'), true);
  assert.equal(connection.calls.some((c) => c.type === 'commit'), false);
  assert.equal(pool.calls.some((c) => c.sql.includes("status = 'retry'")), true);
});
