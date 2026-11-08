import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoricalFinalEventsReplayService } from '../src/application/historical-final-events-replay-service.js';

function person() {
  return { id: 30001, person_code: '900002', display_name: 'Test 900002', status: 'active' };
}

function original(uuid, punchId, type = 'check_in') {
  return {
    final_event_uuid: uuid,
    person_id: 30001,
    person_code: '900002',
    source_punch_id: punchId,
    device_id: 1,
    device_reference: 'zkteco:AJE1261900133',
    event_type: type,
    event_time_local: '2026-09-01 08:00:00.000000',
    event_timezone: 'Asia/Riyadh',
    event_time_utc: '2026-09-01 05:00:00.000000',
    verification_method: 'fingerprint',
    finalization_version: 'v1'
  };
}

test('preview is read-only and returns a bounded historical summary for an active person', async () => {
  const calls = [];
  const replayStore = {
    async getPersonById(id) { calls.push(['person', id]); return person(); },
    async summarizeOriginalFinalEvents(query) {
      calls.push(['summary', query]);
      return { count: 2, earliest_event_time_local: '2026-09-01 08:00:00', latest_event_time_local: '2026-09-02 17:00:00' };
    }
  };
  const service = new HistoricalFinalEventsReplayService({ replayStore });
  const result = await service.preview({ personId: 30001, from: '2026-09-01', to: '2026-09-02' });
  assert.equal(result.count, 2);
  assert.equal(result.person.personCode, '900002');
  assert.equal(calls[1][1].toExclusive, '2026-09-03');
});

test('manual reprocessing requires explicit confirmation and does not run implicitly', async () => {
  const service = new HistoricalFinalEventsReplayService({ replayStore: {} });
  await assert.rejects(
    service.reprocess({ personId: 30001, from: '2026-09-01', to: '2026-09-01', confirmed: false }),
    (error) => error.code === 'HISTORICAL_CONFIRMATION_REQUIRED'
  );
});

test('manual reprocessing creates new immutable Final Event references while preserving original event facts', async () => {
  const originals = [
    original('11111111-1111-4111-8111-111111111111', 60001, 'check_in'),
    { ...original('22222222-2222-4222-8222-222222222222', 60002, 'check_out'), event_time_local: '2026-09-01 17:00:00.000000', event_time_utc: '2026-09-01 14:00:00.000000' }
  ];
  let batch;
  const replayStore = {
    async getPersonById() { return person(); },
    async summarizeOriginalFinalEvents() { return { count: originals.length }; },
    async listOriginalFinalEvents() { return originals; },
    async reissueFinalEvents(input) { batch = input; return { reissuedCount: input.events.length }; }
  };
  const uuids = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ];
  const service = new HistoricalFinalEventsReplayService({
    replayStore,
    uuidFactory: () => uuids.shift(),
    nowFactory: () => new Date('2026-09-06T10:00:00Z')
  });
  const result = await service.reprocess({
    personId: 30001,
    from: '2026-09-01',
    to: '2026-09-01',
    confirmed: true,
    actor: { actorType: 'admin', actorReference: 'local-ui' }
  });

  assert.equal(result.reissuedCount, 2);
  assert.equal(result.batchReference, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(batch.events[0].finalEventUuid, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(batch.events[1].finalEventUuid, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(batch.events[0].sourcePunchId, 60001);
  assert.equal(batch.events[0].eventTimeUtc, originals[0].event_time_utc);
  assert.equal(batch.events[0].eventType, 'check_in');
  assert.match(batch.events[0].finalizationVersion, /^hr-/);
  assert.ok(batch.events[0].finalizationVersion.length <= 32);
  assert.equal(batch.events[0].safeMetadata.historicalReplay.originalFinalEventUuid, originals[0].final_event_uuid);
  assert.equal(batch.auditEntry.actionType, 'historical_final_events_reissued');
  assert.equal(batch.auditEntry.afterState.reissuedCount, 2);
});

test('historical reprocessing rejects invalid or over-wide date ranges', async () => {
  const replayStore = { async getPersonById() { return person(); } };
  const service = new HistoricalFinalEventsReplayService({ replayStore });
  await assert.rejects(service.preview({ personId: 30001, from: '2026-09-10', to: '2026-09-01' }), (e) => e.code === 'HISTORICAL_RANGE_INVALID');
  await assert.rejects(service.preview({ personId: 30001, from: '2026-01-01', to: '2026-03-01' }), (e) => e.code === 'HISTORICAL_RANGE_TOO_LARGE');
});

test('historical reprocessing never reissues more than the safety limit in one operation', async () => {
  const replayStore = {
    async getPersonById() { return person(); },
    async summarizeOriginalFinalEvents() { return { count: 1001 }; }
  };
  const service = new HistoricalFinalEventsReplayService({ replayStore });
  await assert.rejects(
    service.reprocess({ personId: 30001, from: '2026-09-01', to: '2026-09-01', confirmed: true }),
    (error) => error.code === 'HISTORICAL_REPLAY_LIMIT'
  );
});
