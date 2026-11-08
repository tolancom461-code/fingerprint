import test from 'node:test';
import assert from 'node:assert/strict';
import { startAutomaticFinalizationRetryLoop } from '../src/application/start-automatic-finalization-retry-loop.js';
import { AUTOMATIC_FINALIZATION_PENDING_ISSUE } from '../src/domain/finalization.js';

class MemoryLog {
  constructor() { this.items = []; }
  async write(item) { this.items.push(item); }
}

function fixture({ ids = [11, 12], results = new Map(), errors = new Map() } = {}) {
  const log = new MemoryLog();
  const calls = [];
  const touches = [];
  const store = {
    async listOpenIssuePunchIds(options) { calls.push({ type: 'list', options }); return ids; },
    async upsertIssue(issue) { touches.push(issue); return { id: 1, status: 'open' }; }
  };
  const service = {
    async finalizePunchById(id) {
      calls.push({ type: 'finalize', id });
      if (errors.has(id)) throw errors.get(id);
      return results.get(id) ?? { status: 'final', sourcePunchId: id, finalEvent: { id: id + 100 } };
    }
  };
  let tick = null;
  let cleared = false;
  const loop = startAutomaticFinalizationRetryLoop({
    finalizationStore: store,
    finalizationService: service,
    diagnosticLog: log,
    intervalSeconds: 10,
    retryDelaySeconds: 30,
    setIntervalFn(fn) { tick = fn; return { unref() {} }; },
    clearIntervalFn() { cleared = true; }
  });
  return { loop, log, calls, touches, tick: () => tick?.(), cleared: () => cleared };
}

test('retries only durable automatic-finalization pending intents and summarizes outcomes', async () => {
  const results = new Map([[12, { status: 'unresolved', sourcePunchId: 12, issue: { issue_type: 'unmapped_device_user' } }]]);
  const f = fixture({ results });
  const result = await f.loop.runNow();
  assert.deepEqual(result, { eligibleCount: 2, finalCount: 1, unresolvedCount: 1, failedCount: 0 });
  assert.equal(f.calls[0].options.issueType, AUTOMATIC_FINALIZATION_PENDING_ISSUE);
  assert.equal(f.calls[0].options.retryDelaySeconds, 30);
  assert.deepEqual(f.calls.filter((x) => x.type === 'finalize').map((x) => x.id), [11, 12]);
  assert.equal(f.log.items.at(-1).type, 'automatic_finalization_retry_sweep_completed');
});

test('failed retry keeps the durable pending issue open and stores only a safe error code', async () => {
  const error = Object.assign(new Error('secret connection detail should not be copied'), { code: 'DB_TEMP' });
  const f = fixture({ ids: [77], errors: new Map([[77, error]]) });
  const result = await f.loop.runNow();
  assert.equal(result.failedCount, 1);
  assert.equal(f.touches.length, 1);
  assert.equal(f.touches[0].issueType, AUTOMATIC_FINALIZATION_PENDING_ISSUE);
  assert.deepEqual(f.touches[0].details, { errorCode: 'DB_TEMP' });
  assert.equal(JSON.stringify(f.touches).includes('secret connection detail'), false);
});

test('retry loop does not overlap and can be stopped', async () => {
  let resolveList;
  const log = new MemoryLog();
  const store = {
    listOpenIssuePunchIds() { return new Promise((resolve) => { resolveList = resolve; }); },
    async upsertIssue() {}
  };
  const loop = startAutomaticFinalizationRetryLoop({
    finalizationStore: store,
    finalizationService: { async finalizePunchById() { return { status: 'final' }; } },
    diagnosticLog: log,
    setIntervalFn() { return { unref() {} }; },
    clearIntervalFn() {}
  });
  const first = loop.runNow();
  assert.deepEqual(await loop.runNow(), { skipped: true });
  resolveList([]);
  await first;
  loop.stop();
  assert.deepEqual(await loop.runNow(), { skipped: true });
});
