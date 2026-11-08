import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebBridgePushService } from '../src/application/web-bridge-push-service.js';

const event = {
  eventId: '123e4567-e89b-42d3-a456-426614174000',
  personCode: '900001',
  eventType: 'check_in',
  eventTimeUtc: '2026-09-06T11:50:20Z',
  eventTimeLocal: '2026-09-06T14:50:20',
  eventTimezone: 'Asia/Riyadh',
  verificationMethod: 'fingerprint',
  finalizationVersion: 'v1'
};

test('first run initializes at tail without pushing historical events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-bridge-'));
  const calls = [];
  const pages = [
    { apiVersion: 'v1', items: [event], page: { afterId: '0', nextAfterId: '7', limit: 500, hasMore: false } }
  ];
  const service = new WebBridgePushService({
    finalEventsReadService: { list: async (input) => { calls.push(input); return pages.shift(); } },
    targetUrl: 'http://127.0.0.1:3000/api/biometric-bridge/v1/final-events',
    token: 'x'.repeat(40),
    stateFile: path.join(dir, 'state.json'),
    fetchImpl: async () => { throw new Error('must not push on initialization'); }
  });
  const result = await service.runOnce();
  assert.equal(result.state, 'initialized');
  assert.equal(result.cursor, '7');
  assert.equal(result.skippedHistorical, 1);
  assert.equal(calls.length, 1);
});

test('successful push advances durable cursor only after complete acknowledgement', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-bridge-'));
  const stateFile = path.join(dir, 'state.json');
  await fs.writeFile(stateFile, JSON.stringify({ cursor: '7' }));
  const service = new WebBridgePushService({
    finalEventsReadService: {
      list: async () => ({ apiVersion: 'v1', items: [event], page: { afterId: '7', nextAfterId: '8', limit: 100, hasMore: false } })
    },
    targetUrl: 'http://127.0.0.1:3000/api/biometric-bridge/v1/final-events',
    token: 'x'.repeat(40),
    stateFile,
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      assert.equal(payload.sourceCursor, '8');
      assert.equal(payload.events[0].eventId, event.eventId);
      return new Response(JSON.stringify({
        ok: true,
        apiVersion: 'v1',
        received: 1,
        results: [{ eventId: event.eventId, status: 'processed' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const result = await service.runOnce();
  assert.equal(result.state, 'pushed');
  assert.deepEqual(result.counts, { processed: 1 });
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(saved.cursor, '8');
});

test('failed push does not advance cursor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-bridge-'));
  const stateFile = path.join(dir, 'state.json');
  await fs.writeFile(stateFile, JSON.stringify({ cursor: '7' }));
  const service = new WebBridgePushService({
    finalEventsReadService: {
      list: async () => ({ apiVersion: 'v1', items: [event], page: { afterId: '7', nextAfterId: '8', limit: 100, hasMore: false } })
    },
    targetUrl: 'http://127.0.0.1:3000/api/biometric-bridge/v1/final-events',
    token: 'x'.repeat(40),
    stateFile,
    fetchImpl: async () => new Response('{}', { status: 503 })
  });
  await assert.rejects(() => service.runOnce());
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(saved.cursor, '7');
});
