import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilePunchStore } from '../src/infrastructure/storage/file-punch-store.js';
import { FileIngestStore } from '../src/infrastructure/storage/file-ingest-store.js';

test('file punch store serializes concurrent duplicate appends', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-punch-store-'));
  const store = new FilePunchStore(dir);
  const item = { eventKey: 'same', serialNumber: 'S1' };
  const results = await Promise.all(Array.from({ length: 10 }, () => store.putIfAbsent(item)));
  assert.equal(results.filter((result) => result.status === 'inserted').length, 1);
  const text = await fs.readFile(path.join(dir, 'attlog.ndjson'), 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
});

test('durable ingest store serializes duplicates and returns the stored record', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-ingest-store-'));
  const store = new FileIngestStore(dir);
  const item = { dedupeKey: 'same', ingestKey: 'same', vendor: 'zkteco', canonicalPayload: { deviceUserId: '1' } };
  const results = await Promise.all(Array.from({ length: 10 }, () => store.putIfAbsent(item)));

  assert.equal(results.filter((result) => result.status === 'inserted').length, 1);
  assert.equal(results.filter((result) => result.status === 'duplicate').length, 9);
  assert.equal(results.every((result) => result.record.dedupeKey === 'same'), true);

  const text = await fs.readFile(path.join(dir, 'ingest.ndjson'), 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
  assert.equal((await store.list()).length, 1);
});

test('durable ingest store keeps identical vendor dedupe keys separate across devices', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-ingest-scope-'));
  const store = new FileIngestStore(dir);
  const base = {
    dedupeKey: 'same',
    dedupeStrategy: 'vendor-v1',
    dedupeVersion: '1',
    canonicalPayload: { deviceUserId: '1' }
  };
  const first = {
    ...base,
    ingestKey: 'global-a',
    vendor: 'vendor-a',
    serialNumber: 'S1'
  };
  const second = {
    ...base,
    ingestKey: 'global-b',
    vendor: 'vendor-a',
    serialNumber: 'S2'
  };

  const one = await store.putIfAbsent(first);
  const two = await store.putIfAbsent(second);
  assert.equal(one.status, 'inserted');
  assert.equal(two.status, 'inserted');
  assert.equal((await store.list()).length, 2);
});

test('file punch store treats a v0.7 canonical record as the same physical event during upgrade replay', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-punch-legacy-'));
  const historical = {
    eventKey: 'vendor-event-key',
    vendor: 'zkteco',
    serialNumber: 'SERIAL-1'
  };
  await fs.writeFile(path.join(dir, 'attlog.ndjson'), `${JSON.stringify(historical)}\n`, { mode: 0o600 });

  const store = new FilePunchStore(dir);
  const result = await store.putIfAbsent({
    eventKey: 'new-global-storage-key',
    legacyEventKey: 'vendor-event-key',
    vendor: 'zkteco',
    serialNumber: 'SERIAL-1'
  });

  assert.equal(result.status, 'duplicate');
  const text = await fs.readFile(path.join(dir, 'attlog.ndjson'), 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
});
