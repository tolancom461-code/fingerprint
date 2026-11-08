import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbFinalEventsReadStore } from '../src/infrastructure/storage/tidb-final-events-read-store.js';

function poolWith(rows) {
  const calls = [];
  return {
    calls,
    async execute(sql, params = []) { calls.push({ sql, params }); return [rows, []]; }
  };
}

test('Final Events store reads only finalized rows with ascending id cursor pagination', async () => {
  const pool = poolWith([]);
  const store = new TiDbFinalEventsReadStore(pool);
  await store.listFinalEventsAfter('5', 100);
  assert.match(pool.calls[0].sql, /WHERE status = 'final' AND id > \?/);
  assert.match(pool.calls[0].sql, /ORDER BY id ASC/);
  assert.match(pool.calls[0].sql, /LIMIT 101/);
  assert.doesNotMatch(pool.calls[0].sql, /source_punch_id|person_id|device_id|vendor|serial_number|safe_metadata/);
  assert.deepEqual(pool.calls[0].params, ['5']);
});

test('Final Events store uses UUID lookup and rejects invalid input', async () => {
  const pool = poolWith([]);
  const store = new TiDbFinalEventsReadStore(pool);
  await store.getFinalEventByUuid('11111111-1111-4111-8111-111111111111');
  assert.deepEqual(pool.calls[0].params, ['11111111-1111-4111-8111-111111111111']);
  await assert.rejects(() => store.getFinalEventByUuid('../unsafe'), /UUID is invalid/);
  await assert.rejects(() => store.listFinalEventsAfter('-1', 100), /non-negative integer/);
  await assert.rejects(() => store.listFinalEventsAfter('0', 501), /between 1 and 500/);
});
