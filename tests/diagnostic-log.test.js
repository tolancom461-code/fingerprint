import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileDiagnosticLog } from '../src/infrastructure/logging/file-diagnostic-log.js';

test('diagnostic log removes bodies and redacts secret-looking query values', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-log-'));
  const log = new FileDiagnosticLog(dir);
  await log.write({
    type: 'test',
    body: 'NEVER_WRITE_THIS',
    query: { SN: 'ABC', password: 'secret', Token: 'abc123', FWVersion: '1.0' }
  });
  const text = await fs.readFile(path.join(dir, 'service.ndjson'), 'utf8');
  assert.equal(text.includes('NEVER_WRITE_THIS'), false);
  assert.equal(text.includes('secret'), false);
  assert.equal(text.includes('abc123'), false);
  assert.equal(text.includes('[REDACTED]'), true);
  assert.equal(text.includes('FWVersion'), true);
});

test('diagnostic log redacts ZKTeco communication key fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-log-'));
  const log = new FileDiagnosticLog(directory);
  await log.write({ type: 'device_options_observed', fields: { CommKey: '12345', FirmwareVersion: '1.0' } });
  const content = await fs.readFile(path.join(directory, 'service.ndjson'), 'utf8');
  assert.equal(content.includes('12345'), false);
  assert.match(content, /REDACTED/);
  assert.match(content, /FirmwareVersion/);
});


test('diagnostic log keeps non-secret token counters visible', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-log-'));
  const log = new FileDiagnosticLog(directory);
  await log.write({ type: 'device_options_observed', unparsedTokenCount: 3, accessToken: 'SECRET_TOKEN' });
  const content = await fs.readFile(path.join(directory, 'service.ndjson'), 'utf8');
  assert.match(content, /"unparsedTokenCount":3/);
  assert.equal(content.includes('SECRET_TOKEN'), false);
});

test('diagnostic log rotates with bounded retained files and serialized writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-log-'));
  const log = new FileDiagnosticLog(directory, { maxBytes: 64 * 1024, retainFiles: 2 });
  const message = 'x'.repeat(40_000);
  await Promise.all([
    log.write({ type: 'large', sequence: 1, message }),
    log.write({ type: 'large', sequence: 2, message }),
    log.write({ type: 'large', sequence: 3, message })
  ]);
  const names = await fs.readdir(directory);
  assert.equal(names.includes('service.ndjson'), true);
  assert.equal(names.includes('service.ndjson.1'), true);
  assert.equal(names.includes('service.ndjson.2'), true);
  assert.equal(names.includes('service.ndjson.3'), false);
  for (const name of names) {
    const stat = await fs.stat(path.join(directory, name));
    assert.ok(stat.size <= 64 * 1024, `${name} exceeded configured max size`);
  }
});

test('diagnostic session rotates previous active log and starts a clean current-session file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-log-'));
  const activePath = path.join(directory, 'service.ndjson');
  await fs.writeFile(activePath, '{"type":"old_device_request","occurredAt":"2026-08-30T13:15:24.444Z"}\n');

  const fixed = new Date('2026-08-31T06:22:06.656Z');
  const log = new FileDiagnosticLog(directory, {
    timezone: 'Asia/Riyadh',
    sessionId: 'session-test',
    clock: () => fixed
  });

  await log.startSession({ serviceVersion: '0.9.3' });

  const current = await fs.readFile(activePath, 'utf8');
  const previous = await fs.readFile(`${activePath}.1`, 'utf8');
  assert.equal(current.includes('old_device_request'), false);
  assert.equal(previous.includes('old_device_request'), true);

  const entry = JSON.parse(current.trim());
  assert.equal(entry.type, 'diagnostic_session_started');
  assert.equal(entry.serviceVersion, '0.9.3');
  assert.equal(entry.sessionId, 'session-test');
  assert.equal(entry.occurredAt, '2026-08-31T06:22:06.656Z');
  assert.equal(entry.occurredAtLocal, '2026-08-31T09:22:06.656+03:00');
  assert.equal(entry.logTimezone, 'Asia/Riyadh');
});

test('diagnostic entries carry session identity and local Riyadh time', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bio-log-'));
  const log = new FileDiagnosticLog(directory, {
    timezone: 'Asia/Riyadh',
    sessionId: 'session-42'
  });

  await log.write({
    type: 'device_request',
    occurredAt: '2026-08-31T06:30:00.000Z'
  });

  const content = await fs.readFile(path.join(directory, 'service.ndjson'), 'utf8');
  const entry = JSON.parse(content.trim());
  assert.equal(entry.sessionId, 'session-42');
  assert.equal(entry.occurredAt, '2026-08-31T06:30:00.000Z');
  assert.equal(entry.occurredAtLocal, '2026-08-31T09:30:00.000+03:00');
  assert.equal(entry.logTimezone, 'Asia/Riyadh');
});
