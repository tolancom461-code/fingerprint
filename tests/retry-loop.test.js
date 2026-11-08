import test from 'node:test';
import assert from 'node:assert/strict';
import { startDurableIngestRetryLoop } from '../src/application/start-durable-ingest-retry-loop.js';

function record() {
  return {
    ingestEventId: 5, deviceId: 2, ingestKey: 'a'.repeat(64), storageIdentityVersion: '1',
    dedupeKey: 'b'.repeat(64), dedupeStrategy: 'vendor-v1', dedupeVersion: '1', wireHash: 'c'.repeat(64),
    vendor: 'vendor-a', serialNumber: 'S1', deviceKey: 'vendor-a:S1', deviceTimezone: 'Asia/Riyadh',
    parserVersion: 'parser-1', parseValid: true, sourceBytes: 10, receivedAt: '2026-08-30T13:00:00.000Z',
    canonicalPayload: { deviceUserId: '1', deviceEventTime: '2026-08-30 16:00:00', rawStatus: '0', rawVerify: '1' }
  };
}

class MemoryLog { constructor() { this.items = []; } async write(item) { this.items.push(item); } }

test('retry loop reprocesses eligible durable ingest without service restart', async () => {
  let callback;
  let cleared = false;
  const log = new MemoryLog();
  const punched = [];
  const loop = startDurableIngestRetryLoop({
    ingestStore: { async list() { return [record()]; } },
    punchStore: { async putIfAbsent(item) { punched.push(item); return { status: 'inserted' }; } },
    diagnosticLog: log,
    intervalSeconds: 10,
    setIntervalFn(fn, ms) { callback = fn; assert.equal(ms, 10_000); return { unref() {} }; },
    clearIntervalFn() { cleared = true; }
  });

  const result = await loop.runNow();
  assert.equal(result.insertedCount, 1);
  assert.equal(punched.length, 1);
  assert.equal(punched[0].deviceEventTimeUtc, '2026-08-30 13:00:00.000000');
  assert.equal(log.items.some((item) => item.type === 'durable_ingest_retry_sweep_completed'), true);
  assert.equal(typeof callback, 'function');
  loop.stop();
  assert.equal(cleared, true);
});

test('retry loop never overlaps two sweeps', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let listCalls = 0;
  const loop = startDurableIngestRetryLoop({
    ingestStore: { async list() { listCalls += 1; await gate; return []; } },
    punchStore: { async putIfAbsent() { throw new Error('not reached'); } },
    diagnosticLog: new MemoryLog(),
    setIntervalFn() { return { unref() {} }; },
    clearIntervalFn() {}
  });
  const first = loop.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await loop.runNow();
  assert.equal(second.skipped, true);
  assert.equal(listCalls, 1);
  release();
  await first;
  loop.stop();
});
