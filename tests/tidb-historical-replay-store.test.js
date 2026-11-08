import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbHistoricalReplayStore } from '../src/infrastructure/storage/tidb-historical-replay-store.js';

class FakePool {
  constructor(responses = []) { this.responses = [...responses]; this.calls = []; }
  async execute(sql, params) { this.calls.push({ sql, params }); return this.responses.shift() ?? [[], []]; }
}

test('historical candidate reads exclude prior replay rows and stay scoped to person and local date range', async () => {
  const pool = new FakePool([[[{ count: 3, earliest_event_time_local: '2026-09-01 08:00:00', latest_event_time_local: '2026-09-02 17:00:00' }], []]]);
  const store = new TiDbHistoricalReplayStore(pool);
  const result = await store.summarizeOriginalFinalEvents({ personId: 30001, from: '2026-09-01', toExclusive: '2026-09-03' });
  assert.equal(result.count, 3);
  assert.match(pool.calls[0].sql, /finalization_version NOT LIKE \?/);
  assert.deepEqual(pool.calls[0].params, [30001, '2026-09-01 00:00:00', '2026-09-03 00:00:00', 'hr-%']);
});

test('reissue writes Final Events and audit in one transaction', async () => {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async execute(sql, params) { calls.push({ sql, params }); return [{ insertId: 1 }, []]; },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); }
  };
  const pool = { async getConnection() { return connection; } };
  const store = new TiDbHistoricalReplayStore(pool);
  const event = {
    finalEventUuid: '11111111-1111-4111-8111-111111111111', personId: 30001, personCode: '900002', sourcePunchId: 60001,
    deviceId: 1, deviceReference: 'zkteco:AJE1261900133', eventType: 'check_in', eventTimeLocal: '2026-09-01 08:00:00',
    eventTimezone: 'Asia/Riyadh', eventTimeUtc: '2026-09-01 05:00:00', verificationMethod: 'fingerprint',
    finalizationVersion: 'hr-20260906100000-aaaaaaaa', safeMetadata: { historicalReplay: { kind: 'manual_historical_reprocess' } }
  };
  const result = await store.reissueFinalEvents({
    events: [event],
    auditEntry: { actorType: 'admin', actorReference: 'local-ui', actionType: 'historical_final_events_reissued', entityType: 'person', entityId: 30001, afterState: { reissuedCount: 1 } }
  });
  assert.equal(result.reissuedCount, 1);
  assert.equal(calls[0], 'begin');
  assert.match(calls[1].sql, /INSERT INTO `biometric_svc_final_events`/);
  assert.match(calls[2].sql, /INSERT INTO `biometric_svc_audit_log`/);
  assert.equal(calls[3], 'commit');
  assert.equal(calls.at(-1), 'release');
});
