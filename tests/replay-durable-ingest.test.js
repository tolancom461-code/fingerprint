import test from 'node:test';
import assert from 'node:assert/strict';
import { replayDurableIngest } from '../src/application/replay-durable-ingest.js';

class MemoryPunchStore {
  constructor() { this.keys = new Set(); this.items = []; }
  async putIfAbsent(item) {
    if (this.keys.has(item.eventKey)) return { status: 'duplicate' };
    this.keys.add(item.eventKey);
    this.items.push(item);
    return { status: 'inserted' };
  }
}
class MemoryLog { constructor() { this.items = []; } async write(item) { this.items.push(item); } }

function durableRecord() {
  return {
    ingestKey: 'event-1',
    dedupeKey: 'event-1',
    dedupeStrategy: 'vendor-strategy-v1',
    dedupeVersion: '1',
    wireHash: 'wire-1',
    parserVersion: 'parser-1',
    vendor: 'vendor-a',
    serialNumber: 'S1',
    deviceKey: 'vendor-a:S1',
    parseValid: true,
    sourceBytes: 40,
    receivedAt: '2026-08-30T08:00:00.000Z',
    canonicalPayload: {
      deviceUserId: '100',
      deviceEventTime: '2026-08-30 11:00:00',
      rawStatus: '0',
      rawVerify: '1',
      workCode: '0',
      delimiter: 'tab',
      extraFields: ['0']
    }
  };
}

test('startup replay reconstructs a missing canonical punch from durable ingest idempotently', async () => {
  const ingestStore = { async list() { return [durableRecord()]; } };
  const punchStore = new MemoryPunchStore();
  const log = new MemoryLog();

  const first = await replayDurableIngest({ ingestStore, punchStore, diagnosticLog: log });
  const second = await replayDurableIngest({ ingestStore, punchStore, diagnosticLog: log });

  assert.equal(first.insertedCount, 1);
  assert.equal(second.duplicateCount, 1);
  assert.equal(punchStore.items.length, 1);
  assert.equal(punchStore.items[0].eventKey, 'event-1');
});
