import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestStorageKey, resolveIngestStorageKey } from '../src/domain/storage-identity.js';

test('storage identity is deterministic for the same device and vendor dedupe tuple', () => {
  const input = {
    vendor: 'vendor-a',
    serialNumber: 'SERIAL-1',
    dedupeStrategy: 'vendor-event-v1',
    dedupeVersion: '1',
    dedupeKey: 'same-vendor-event-key'
  };
  assert.equal(createIngestStorageKey(input), createIngestStorageKey(input));
});

test('same vendor dedupe key on different devices cannot collide in durable storage', () => {
  const base = { vendor: 'vendor-a', dedupeStrategy: 'vendor-event-v1', dedupeVersion: '1', dedupeKey: 'same' };
  assert.notEqual(
    createIngestStorageKey({ ...base, serialNumber: 'SERIAL-1' }),
    createIngestStorageKey({ ...base, serialNumber: 'SERIAL-2' })
  );
});

test('same serial and dedupe key under different vendors cannot collide in durable storage', () => {
  const base = { serialNumber: 'SERIAL-1', dedupeStrategy: 'event-v1', dedupeVersion: '1', dedupeKey: 'same' };
  assert.notEqual(
    createIngestStorageKey({ ...base, vendor: 'vendor-a' }),
    createIngestStorageKey({ ...base, vendor: 'vendor-b' })
  );
});

test('legacy ingest records are resolved from their complete dedupe tuple instead of trusting old ingestKey', () => {
  const legacy = {
    ingestKey: 'old-unqualified-key',
    vendor: 'vendor-a',
    serialNumber: 'SERIAL-1',
    dedupeStrategy: 'event-v1',
    dedupeVersion: '1',
    dedupeKey: 'old-unqualified-key'
  };
  assert.notEqual(resolveIngestStorageKey(legacy), legacy.ingestKey);
});
