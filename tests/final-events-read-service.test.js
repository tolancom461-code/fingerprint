import test from 'node:test';
import assert from 'node:assert/strict';
import { FinalEventsReadService } from '../src/application/final-events-read-service.js';

const rows = [
  {
    id: '4', final_event_uuid: '11111111-1111-4111-8111-111111111111', person_code: '900001',
    event_type: 'check_in', event_time_local: '2026-08-31 10:31:00', event_timezone: 'Asia/Riyadh',
    event_time_utc: '2026-08-31 07:31:00', verification_method: 'fingerprint', finalization_version: 'v1'
  },
  {
    id: '5', final_event_uuid: '22222222-2222-4222-8222-222222222222', person_code: '900003',
    event_type: 'check_in', event_time_local: '2026-09-02 13:47:52', event_timezone: 'Asia/Riyadh',
    event_time_utc: '2026-09-02 10:47:52', verification_method: 'fingerprint', finalization_version: 'v1'
  }
];

test('Final Events API contract exposes only stable vendor-neutral fields', async () => {
  const service = new FinalEventsReadService({
    readStore: {
      async listFinalEventsAfter() { return rows; },
      async getFinalEventByUuid() { return rows[1]; }
    }
  });

  const page = await service.list({ afterId: '0', limit: 2 });
  assert.deepEqual(page, {
    apiVersion: 'v1',
    items: [
      {
        eventId: rows[0].final_event_uuid, personCode: '900001', eventType: 'check_in',
        eventTimeUtc: '2026-08-31T07:31:00Z', eventTimeLocal: '2026-08-31T10:31:00',
        eventTimezone: 'Asia/Riyadh', verificationMethod: 'fingerprint', finalizationVersion: 'v1'
      },
      {
        eventId: rows[1].final_event_uuid, personCode: '900003', eventType: 'check_in',
        eventTimeUtc: '2026-09-02T10:47:52Z', eventTimeLocal: '2026-09-02T13:47:52',
        eventTimezone: 'Asia/Riyadh', verificationMethod: 'fingerprint', finalizationVersion: 'v1'
      }
    ],
    page: { afterId: '0', nextAfterId: '5', limit: 2, hasMore: false }
  });

  const serialized = JSON.stringify(page);
  for (const forbidden of ['person_id', 'source_punch_id', 'device_id', 'vendor', 'serial_number', 'safe_metadata', 'raw_']) {
    assert.equal(serialized.includes(forbidden), false, `contract leaked ${forbidden}`);
  }
});

test('cursor pagination is deterministic and replay-safe', async () => {
  const calls = [];
  const store = {
    async listFinalEventsAfter(afterId, limit) {
      calls.push({ afterId, limit });
      return rows;
    }
  };
  const service = new FinalEventsReadService({ readStore: store });
  const first = await service.list({ afterId: '0', limit: 1 });
  const replay = await service.list({ afterId: '0', limit: 1 });
  assert.deepEqual(first, replay);
  assert.equal(first.items.length, 1);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.page.nextAfterId, '4');
  assert.deepEqual(calls, [{ afterId: '0', limit: 1 }, { afterId: '0', limit: 1 }]);
});

test('single event lookup returns 404 semantic error when absent', async () => {
  const service = new FinalEventsReadService({ readStore: { async getFinalEventByUuid() { return null; } } });
  await assert.rejects(() => service.getByUuid('11111111-1111-4111-8111-111111111111'), (error) => error.code === 'FINAL_EVENT_NOT_FOUND');
});
