import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbPunchStore } from '../src/infrastructure/storage/tidb-punch-store.js';

class FakeConnection {
  constructor({ failPunch = false, failIntent = false, duplicatePunch = false, identities = [], lockRows = [{ id: 7 }] } = {}) {
    this.failPunch = failPunch; this.failIntent = failIntent; this.duplicatePunch = duplicatePunch; this.calls = [];
    this.identities = identities; this.lockRows = lockRows;
  }
  async beginTransaction() { this.calls.push({ type: 'begin' }); }
  async commit() { this.calls.push({ type: 'commit' }); }
  async rollback() { this.calls.push({ type: 'rollback' }); }
  release() { this.calls.push({ type: 'release' }); }
  async execute(sql, params = []) {
    this.calls.push({ type: 'execute', sql, params });
    if (sql === 'SELECT id FROM `biometric_svc_devices` WHERE id = ? FOR UPDATE') return [this.lockRows];
    if (sql.startsWith('SELECT id, status, identity_started_at')) return [this.identities];
    if (sql.startsWith('INSERT INTO `biometric_svc_device_users`')) return [{ affectedRows: 1, insertId: '31' }];
    if (this.failPunch && sql.startsWith('INSERT INTO `biometric_svc_punches`')) throw new Error('storage failed');
    if (this.duplicatePunch && sql.startsWith('INSERT INTO `biometric_svc_punches`')) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
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
  const userWrite = connection.calls.find(c => c.sql?.startsWith('INSERT INTO `biometric_svc_device_users`'));
  assert.doesNotMatch(userWrite.sql.split('ON DUPLICATE KEY UPDATE')[1], /\bstatus\s*=/);
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

test('base storage preserves an eligible capture intent even without the automatic execution wrapper', async () => {
  const connection = new FakeConnection();
  const store = new TiDbPunchStore({ pool: new FakePool(connection) });
  const result = await store.putIfAbsent({ ...punch(), automaticFinalizationEligible: true });
  assert.equal(result.status, 'inserted');
  const intent = connection.calls.find(call => call.sql?.startsWith('INSERT INTO `biometric_svc_finalization_issues`'));
  assert.ok(intent);
  assert.equal(intent.params[1], 'automatic_finalization_pending');
  assert.ok(connection.calls.indexOf(intent) < connection.calls.findIndex(call => call.type === 'commit'));
});

test('an explicit false intent option overrides durable eligibility for a deliberate non-automatic operation', async () => {
  const connection = new FakeConnection();
  const store = new TiDbPunchStore({ pool: new FakePool(connection) });
  await store.putIfAbsent({ ...punch(), automaticFinalizationEligible: true }, { createAutomaticFinalizationIntent: false });
  assert.equal(connection.calls.some(call => call.sql?.startsWith('INSERT INTO `biometric_svc_finalization_issues`')), false);
});

test('a duplicate canonical punch never reopens an automatic intent even if its capture is eligible', async () => {
  const connection = new FakeConnection({ duplicatePunch: true });
  const store = new TiDbPunchStore({ pool: new FakePool(connection) });
  assert.equal((await store.putIfAbsent({ ...punch(), automaticFinalizationEligible: true })).status, 'duplicate');
  assert.equal(connection.calls.some(call => call.sql?.startsWith('INSERT INTO `biometric_svc_finalization_issues`')), false);
});

const retiredIdentity = { id: '10', status: 'absent_from_device', identity_started_at: null,
  identity_ended_at: '2026-08-30 11:00:00.123456' };
const newIdentity = { id: '20', status: 'seen', identity_started_at: '2026-08-30 11:05:00', identity_ended_at: null };

async function writeIdentityPunch(identities, utcTime, options = {}) {
  const connection = new FakeConnection({ identities, ...options });
  const store = new TiDbPunchStore({ pool: new FakePool(connection), deviceUserIdentityEnabled: true });
  const result = await store.putIfAbsent({ ...punch(), deviceEventTimeUtc: utcTime, receivedAt: '2026-08-30T15:30:00Z' });
  const write = connection.calls.find(call => call.sql?.startsWith('INSERT INTO `biometric_svc_punches`'));
  assert.match(write.sql, /received_at, device_user_row_id/);
  assert.deepEqual(connection.calls[1], { type: 'execute', sql: 'SELECT id FROM `biometric_svc_devices` WHERE id = ? FOR UPDATE', params: [7] });
  const identityRead = connection.calls.find(call => call.sql?.startsWith('SELECT id, status, identity_started_at'));
  assert.match(identityRead.sql, /ORDER BY id FOR UPDATE$/);
  assert.ok(connection.calls.indexOf(identityRead) < connection.calls.indexOf(write));
  return { result, bound: write.params.at(-1), writes: connection.calls.filter(call => /^(?:INSERT INTO|UPDATE) `biometric_svc_device_users`/.test(call.sql ?? '')) };
}

test('delayed ATTLOG binds to the identity valid at the event time, including microsecond boundaries', async () => {
  const rows = [retiredIdentity, newIdentity];
  const old = await writeIdentityPunch(rows, '2026-08-30 11:00:00.123455');
  assert.equal(old.bound, '10');
  assert.equal(old.writes.length, 0);
  assert.equal((await writeIdentityPunch(rows, retiredIdentity.identity_ended_at)).bound, null);
  const current = await writeIdentityPunch(rows, newIdentity.identity_started_at);
  assert.equal(current.bound, '20');
  assert.equal(current.writes.length, 1);
  assert.equal(current.writes[0].params[2], '20');
  assert.match(current.writes[0].sql, /identity_ended_at IS NULL AND status <> 'absent_from_device'/);
});

test('unavailable times and overlapping intervals preserve a canonical punch without guessed identity', async () => {
  const rows = [{ ...retiredIdentity, identity_ended_at: '2026-08-30 11:10:00' }, newIdentity];
  for (const utcTime of [null, '2026-08-30 11:06:00']) {
    const result = await writeIdentityPunch(rows, utcTime);
    assert.equal(result.result.status, 'inserted');
    assert.equal(result.bound, null);
    assert.equal(result.writes.length, 0);
  }
});

test('legacy historical identities with unknown end stay retired and unassigned on delayed ATTLOG', async () => {
  const archived = { ...retiredIdentity, identity_ended_at: null };
  const old = await writeIdentityPunch([archived], '2026-08-30 11:00:00');
  assert.equal(old.bound, null);
  assert.equal(old.writes.length, 0);
  assert.equal((await writeIdentityPunch([archived, newIdentity], '2026-08-30 11:06:00')).bound, '20');
});

test('first ATTLOG for an unseen PIN can create an identity but duplicate writes cannot change attribution', async () => {
  const first = await writeIdentityPunch([], '2026-08-30 11:00:00');
  assert.equal(first.bound, '31');
  assert.match(first.writes[0].sql, /^INSERT INTO/);
  const duplicate = await writeIdentityPunch([retiredIdentity, newIdentity], '2026-08-30 11:06:00', { duplicatePunch: true });
  assert.equal(duplicate.result.status, 'duplicate');
  assert.equal(duplicate.writes.length, 0);
});

test('failure to acquire the device lock does not read or write an identity or punch', async () => {
  const connection = new FakeConnection({ lockRows: [] });
  const store = new TiDbPunchStore({ pool: new FakePool(connection), deviceUserIdentityEnabled: true });
  await assert.rejects(store.putIfAbsent(punch()), /identity lock unavailable/);
  assert.equal(connection.calls.filter(call => call.type === 'execute').length, 1);
  assert.ok(connection.calls.some(call => call.type === 'rollback'));
});
