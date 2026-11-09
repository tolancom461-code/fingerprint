import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalPunchFromIngest } from '../src/domain/punch.js';
import { replayDurableIngest } from '../src/application/replay-durable-ingest.js';
import { TiDbPunchStore } from '../src/infrastructure/storage/tidb-punch-store.js';

function record(automaticFinalizationEligible) {
  return { ingestEventId: '21', deviceId: '7', ingestKey: 'a'.repeat(64), storageIdentityVersion: '1',
    dedupeKey: 'b'.repeat(64), dedupeStrategy: 'test-source-v1', dedupeVersion: '1', wireHash: 'c'.repeat(64),
    parserVersion: 'test-parser-v1', vendor: 'test-vendor', serialNumber: 'TEST-1', deviceKey: 'test-vendor:TEST-1',
    deviceTimezone: 'Asia/Riyadh', parseValid: true, sourceBytes: 30, receivedAt: '2026-11-09T07:00:00Z',
    automaticFinalizationEligible, canonicalPayload: { deviceUserId: 'TEST-100', deviceEventTime: '2026-11-09 10:00:00',
      rawStatus: '0', rawVerify: '1', punchState: 'check_in', verificationMethod: 'fingerprint',
      automaticFinalizationEligible: true } };
}

test('canonical conversion carries only a strict trusted ingest eligibility flag outside device payload', () => {
  for (const value of [undefined, false, 0, 1, 'true', '1', true]) {
    const punch = createCanonicalPunchFromIngest(record(value));
    assert.equal(punch.automaticFinalizationEligible, value === true);
    assert.equal(punch.eventKey, 'a'.repeat(64));
    assert.equal(punch.deviceEventTimeUtc, '2026-11-09 07:00:00.000000');
  }
});

test('startup replay on the base store preserves eligible intents but never finalizes old raw records', async () => {
  for (const eligible of [false, true]) {
    const calls = [];
    const connection = { async beginTransaction() {}, async commit() { calls.push('commit'); }, async rollback() {}, release() {},
      async execute(sql, params) { calls.push({ sql, params }); return [{ insertId: '40', affectedRows: 1 }]; } };
    const punchStore = new TiDbPunchStore({ pool: { async getConnection() { return connection; } } });
    const result = await replayDurableIngest({ ingestStore: { async list() { return [record(eligible)]; } },
      punchStore, diagnosticLog: { async write() {} } });
    assert.equal(result.insertedCount, 1);
    const intent = calls.find(call => call.sql?.startsWith('INSERT INTO `biometric_svc_finalization_issues`'));
    assert.equal(Boolean(intent), eligible);
    if (intent) assert.ok(calls.indexOf(intent) < calls.indexOf('commit'));
    assert.equal(calls.some(call => call.sql?.includes('INSERT INTO `biometric_svc_final_events`')), false);
  }
});
