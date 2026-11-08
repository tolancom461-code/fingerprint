import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticFinalizingPunchStore } from '../src/application/automatic-finalizing-punch-store.js';

class MemoryLog {
  constructor() { this.items = []; }
  async write(item) { this.items.push(item); }
}

function setup({ storeResult = { status: 'inserted', punchId: '60002' }, finalizeResult, finalizeError } = {}) {
  const calls = [];
  const log = new MemoryLog();
  const punchStore = {
    async putIfAbsent(punch, options) { calls.push({ type: 'punch', punch, options }); return storeResult; }
  };
  const finalizationService = {
    async finalizePunchById(id) {
      calls.push({ type: 'finalize', id });
      if (finalizeError) throw finalizeError;
      return finalizeResult ?? {
        status: 'final', sourcePunchId: Number(id),
        finalEvent: { id: '8', person_code: '900002', event_type: 'check_in' }
      };
    }
  };
  const wrapper = new AutomaticFinalizingPunchStore({
    punchStore,
    finalizationService,
    diagnosticLog: log,
    clock: () => new Date('2026-09-02T09:00:00.000Z')
  });
  return { wrapper, calls, log };
}

test('automatically finalizes only a newly inserted canonical punch', async () => {
  const f = setup();
  const result = await f.wrapper.putIfAbsent({ eventKey: 'new' });
  assert.equal(result.status, 'inserted');
  assert.equal(result.automaticFinalization.status, 'final');
  assert.equal(result.automaticFinalization.sourcePunchId, 60002);
  assert.deepEqual(f.calls.map((x) => x.type), ['punch', 'finalize']);
  assert.equal(f.calls[0].options.createAutomaticFinalizationIntent, true);
  assert.equal(f.calls[1].id, 60002);
  assert.equal(f.log.items.some((x) => x.type === 'automatic_finalization_succeeded'), true);
});

test('does not automatically finalize duplicate canonical punches', async () => {
  const f = setup({ storeResult: { status: 'duplicate' } });
  const result = await f.wrapper.putIfAbsent({ eventKey: 'old-or-retried' });
  assert.equal(result.status, 'duplicate');
  assert.deepEqual(f.calls.map((x) => x.type), ['punch']);
  assert.equal(f.log.items.length, 0);
});

test('unmapped new punch stays durable and records unresolved automatic finalization', async () => {
  const f = setup({
    finalizeResult: {
      status: 'unresolved', sourcePunchId: 60002,
      issue: { id: '9', issue_type: 'unmapped_device_user', status: 'open' }
    }
  });
  const result = await f.wrapper.putIfAbsent({ eventKey: 'new' });
  assert.equal(result.status, 'inserted');
  assert.equal(result.automaticFinalization.status, 'unresolved');
  assert.equal(result.automaticFinalization.issueType, 'unmapped_device_user');
  assert.equal(f.log.items.some((x) => x.type === 'automatic_finalization_unresolved'), true);
});

test('finalization failure never turns a durable canonical insert into storage failure', async () => {
  const error = Object.assign(new Error('final event storage temporarily unavailable'), { code: 'DB_TEMP' });
  const f = setup({ finalizeError: error });
  const result = await f.wrapper.putIfAbsent({ eventKey: 'new' });
  assert.equal(result.status, 'inserted');
  assert.equal(result.automaticFinalization.status, 'failed');
  assert.equal(f.log.items.some((x) => x.type === 'automatic_finalization_failed'), true);
});

test('missing inserted punch id fails closed for finalization without failing canonical durability', async () => {
  const f = setup({ storeResult: { status: 'inserted' } });
  const result = await f.wrapper.putIfAbsent({ eventKey: 'new' });
  assert.equal(result.status, 'inserted');
  assert.equal(result.automaticFinalization.status, 'failed');
  assert.deepEqual(f.calls.map((x) => x.type), ['punch']);
  assert.equal(f.log.items[0].reason, 'inserted_punch_id_missing');
});
