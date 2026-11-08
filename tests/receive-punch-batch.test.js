import test from 'node:test';
import assert from 'node:assert/strict';
import { ReceivePunchBatch } from '../src/application/receive-punch-batch.js';
import { EnvDeviceRegistry } from '../src/infrastructure/storage/env-device-registry.js';
import { parseAttlogBody } from '../src/infrastructure/vendors/zkteco/adms-parser.js';
import { createZktecoAttlogObservations } from '../src/infrastructure/vendors/zkteco/attlog-observation.js';

class MemoryIngestStore {
  constructor() { this.items = new Map(); }
  async putIfAbsent(item) {
    const existing = this.items.get(item.ingestKey);
    if (existing) return { status: 'duplicate', record: existing };
    this.items.set(item.ingestKey, item);
    return { status: 'inserted', record: item };
  }
  async list() { return [...this.items.values()]; }
}

class MemoryPunchStore {
  constructor() { this.keys = new Set(); this.items = []; }
  async putIfAbsent(item) {
    if (this.keys.has(item.eventKey)) return { status: 'duplicate' };
    this.keys.add(item.eventKey);
    this.items.push(item);
    return { status: 'inserted' };
  }
}

class MemoryLog {
  constructor() { this.items = []; }
  async write(item) { this.items.push(item); }
}

function setup(allowedDevices = ['zkteco:KNOWN'], overrides = {}) {
  const ingestStore = overrides.ingestStore || new MemoryIngestStore();
  const punchStore = overrides.punchStore || new MemoryPunchStore();
  const log = new MemoryLog();
  const useCase = new ReceivePunchBatch({
    deviceRegistry: new EnvDeviceRegistry(allowedDevices),
    ingestStore,
    punchStore,
    diagnosticLog: log,
    clock: () => new Date('2026-08-23T10:00:00.000Z')
  });
  return { ingestStore, punchStore, log, useCase };
}

function execute(useCase, { vendor = 'zkteco', serialNumber = 'KNOWN', body }) {
  const device = { vendor, serialNumber };
  const parsedLines = parseAttlogBody(body);
  const observations = createZktecoAttlogObservations({ device, parsedLines, parserVersion: 'test-parser' });
  return useCase.execute({ device, observations, remoteAddress: '127.0.0.1' });
}

test('rejects an unknown terminal before accepting a punch batch', async () => {
  const { ingestStore, punchStore, useCase } = setup();
  const result = await execute(useCase, {
    serialNumber: 'UNKNOWN',
    body: '1\t2026-08-23 10:00:00\t0\t1'
  });
  assert.equal(result.allowed, false);
  assert.equal(ingestStore.items.size, 0);
  assert.equal(punchStore.items.length, 0);
});

test('durably stores sanitized ingest before creating the canonical punch', async () => {
  const { ingestStore, punchStore, useCase } = setup();
  const result = await execute(useCase, { body: '125\t2026-08-23 08:01:30\t0\t1\tA' });

  assert.equal(result.acceptedCount, 1);
  assert.equal(result.safeToAcknowledge, true);
  assert.equal(ingestStore.items.size, 1);
  assert.equal(punchStore.items.length, 1);

  const ingest = [...ingestStore.items.values()][0];
  assert.equal(ingest.vendor, 'zkteco');
  assert.equal(ingest.serialNumber, 'KNOWN');
  assert.equal(ingest.canonicalPayload.rawStatus, '0');
  assert.equal(ingest.canonicalPayload.rawVerify, '1');
  assert.equal(ingest.canonicalPayload.punchState, null);
  assert.equal(ingest.canonicalPayload.verificationMethod, null);
  assert.equal('rawLine' in ingest, false);
  assert.equal('rawFields' in ingest, false);

  const punch = punchStore.items[0];
  assert.equal(punch.deviceKey, 'zkteco:KNOWN');
  assert.equal(punch.rawStatus, '0');
  assert.equal(punch.rawVerify, '1');
  assert.equal(punch.deviceEventTime, '2026-08-23 08:01:30');
  assert.equal(punch.punchState, null);
  assert.equal(punch.verificationMethod, null);
  assert.equal('rawLine' in punch, false);
});

test('tested SpeedFace terminal persists the proven normalized punch and verification meanings', async () => {
  const serialNumber = 'AJE1261900133';
  const { ingestStore, punchStore, useCase } = setup([`zkteco:${serialNumber}`]);
  const result = await execute(useCase, {
    serialNumber,
    body: '900001\t2026-08-30 15:16:27\t0\t1\t0\t0\t0\t255\t0\t0'
  });

  assert.equal(result.acceptedCount, 1);
  const ingest = [...ingestStore.items.values()][0];
  assert.equal(ingest.canonicalPayload.rawStatus, '0');
  assert.equal(ingest.canonicalPayload.punchState, 'check_in');
  assert.equal(ingest.canonicalPayload.rawVerify, '1');
  assert.equal(ingest.canonicalPayload.verificationMethod, 'fingerprint');
  assert.match(ingest.canonicalPayload.normalizationProfile, /^speedface-v5l-/);

  const punch = punchStore.items[0];
  assert.equal(punch.rawStatus, '0');
  assert.equal(punch.punchState, 'check_in');
  assert.equal(punch.rawVerify, '1');
  assert.equal(punch.verificationMethod, 'fingerprint');
});

test('deduplicates the same physical punch even if auxiliary work-code changes', async () => {
  const { ingestStore, punchStore, useCase } = setup();
  const first = await execute(useCase, { body: '125\t2026-08-23 08:01:30\t0\t1\tA' });
  const second = await execute(useCase, { body: '125\t2026-08-23 08:01:30\t0\t1\tB' });

  assert.equal(first.acceptedCount, 1);
  assert.equal(second.duplicateCount, 1);
  assert.equal(ingestStore.items.size, 1);
  assert.equal(punchStore.items.length, 1);
});

test('unknown ATTLOG shape is retained only as safe metadata and is not acknowledgement-safe', async () => {
  const { ingestStore, punchStore, useCase } = setup();
  const secret = 'UNKNOWN-LAYOUT-PRIVATE-CONTENT';
  const result = await execute(useCase, { body: secret });

  assert.equal(result.invalidCount, 1);
  assert.equal(result.unsafeCount, 1);
  assert.equal(result.safeToAcknowledge, false);
  assert.equal(ingestStore.items.size, 1);
  assert.equal(punchStore.items.length, 0);

  const persisted = JSON.stringify([...ingestStore.items.values()][0]);
  assert.equal(persisted.includes(secret), false);
});

test('same serial number under different vendors is a different durable identity', async () => {
  const ingestStore = new MemoryIngestStore();
  const punchStore = new MemoryPunchStore();
  const log = new MemoryLog();
  const registry = new EnvDeviceRegistry(['zkteco:SAME', 'futurevendor:SAME']);
  const useCase = new ReceivePunchBatch({ deviceRegistry: registry, ingestStore, punchStore, diagnosticLog: log });
  const parsed = parseAttlogBody('125\t2026-08-23 08:01:30\t0\t1');

  const zkDevice = { vendor: 'zkteco', serialNumber: 'SAME' };
  const futureDevice = { vendor: 'futurevendor', serialNumber: 'SAME' };
  const zkObservation = createZktecoAttlogObservations({ device: zkDevice, parsedLines: parsed, parserVersion: 'zk' });
  const futureObservation = [{ ...zkObservation[0] }];

  await useCase.execute({ device: zkDevice, observations: zkObservation });
  await useCase.execute({ device: futureDevice, observations: futureObservation });

  assert.equal(ingestStore.items.size, 2);
  assert.equal(punchStore.items.length, 2);
  assert.notEqual(punchStore.items[0].deviceKey, punchStore.items[1].deviceKey);
  assert.equal(zkObservation[0].dedupeKey, futureObservation[0].dedupeKey);
  assert.notEqual(punchStore.items[0].eventKey, punchStore.items[1].eventKey);
});

test('canonical processing failure does not undo durable ingest or acknowledgement eligibility', async () => {
  const failingPunchStore = { async putIfAbsent() { throw new Error('canonical store unavailable'); } };
  const { ingestStore, log, useCase } = setup(['zkteco:KNOWN'], { punchStore: failingPunchStore });

  const result = await execute(useCase, { body: '125\t2026-08-23 08:01:30\t0\t1' });

  assert.equal(ingestStore.items.size, 1);
  assert.equal(result.canonicalPendingCount, 1);
  assert.equal(result.safeToAcknowledge, true);
  assert.equal(log.items.some((item) => item.type === 'canonical_punch_processing_failed'), true);
});

test('durable ingest failure propagates so caller cannot acknowledge', async () => {
  const failingIngestStore = {
    async putIfAbsent() { throw new Error('durable ingest unavailable'); },
    async list() { return []; }
  };
  const { useCase } = setup(['zkteco:KNOWN'], { ingestStore: failingIngestStore });
  await assert.rejects(
    execute(useCase, { body: '125\t2026-08-23 08:01:30\t0\t1' }),
    /durable ingest unavailable/
  );
});

test('a safe retry cannot acknowledge over an earlier durable unsafe record with the same event identity', async () => {
  const { ingestStore, punchStore, useCase } = setup();
  const unsafe = await execute(useCase, { body: '125\t2026-08-23 08:01:30\t0\t1\tA\tNOT-CLASSIFIED' });
  const safeRetry = await execute(useCase, { body: '125\t2026-08-23 08:01:30\t0\t1\tA\t0' });

  assert.equal(unsafe.safeToAcknowledge, false);
  assert.equal(safeRetry.duplicateCount, 1);
  assert.equal(safeRetry.safeToAcknowledge, false);
  assert.equal(ingestStore.items.size, 1);
  assert.equal(punchStore.items.length, 0);
});

test('durable but policy-filtered event remains acknowledgement-safe without canonical punch', async () => {
  const baseStore = new MemoryIngestStore();
  const policyStore = {
    items: baseStore.items,
    async putIfAbsent(item) {
      const result = await baseStore.putIfAbsent(item);
      return { ...result, canonicalEligible: false, policyReason: 'before_accept_events_from' };
    },
    async list() { return []; }
  };
  const { punchStore, useCase } = setup(['zkteco:KNOWN'], { ingestStore: policyStore });
  const result = await execute(useCase, { body: '125\t2026-08-23 08:01:30\t0\t1' });
  assert.equal(result.safeToAcknowledge, true);
  assert.equal(result.canonicalNotApplicableCount, 1);
  assert.equal(punchStore.items.length, 0);
  assert.equal(baseStore.items.size, 1);
});
