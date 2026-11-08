import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/env.js';

const KEYS = [
  'BIOMETRIC_STORAGE_MODE', 'BIOMETRIC_DB_HOST', 'BIOMETRIC_DB_PORT', 'BIOMETRIC_DB_USER',
  'BIOMETRIC_DB_PASSWORD', 'BIOMETRIC_DB_NAME', 'BIOMETRIC_DB_SSL_MODE',
  'BIOMETRIC_DB_RETRY_DELAY_SECONDS', 'BIOMETRIC_DB_RETRY_SWEEP_SECONDS',
  'BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES',
  'BIOMETRIC_ADMIN_ENABLED', 'BIOMETRIC_ADMIN_HOST', 'BIOMETRIC_ADMIN_PORT',
  'BIOMETRIC_FINAL_EVENTS_API_ENABLED', 'BIOMETRIC_FINAL_EVENTS_API_HOST', 'BIOMETRIC_FINAL_EVENTS_API_PORT',
  'BIOMETRIC_FINAL_EVENTS_API_TOKEN',
  'BIOMETRIC_LOG_MAX_BYTES', 'BIOMETRIC_LOG_RETAIN_FILES'
];

async function withEnv(values, fn) {
  const before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, values);
    return await fn();
  } finally {
    for (const key of KEYS) {
      if (before[key] == null) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test('database storage is the default and fails closed without independent credentials', async () => {
  await withEnv({}, async () => {
    assert.throws(() => loadConfig('/tmp/biometric'), /BIOMETRIC_DB_HOST is required/);
  });
});

test('database config selects test explicitly and requires TLS by default', async () => {
  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret'
  }, async () => {
    const config = loadConfig('/tmp/biometric');
    assert.equal(config.storageMode, 'database');
    assert.equal(config.database.database, 'test');
    assert.equal(config.database.sslMode, 'required');
    assert.equal(config.autoFinalizeNewPunches, true);
    assert.deepEqual(config.admin, { enabled: true, host: '127.0.0.1', port: 9096 });
    assert.deepEqual(config.finalEventsApi, { enabled: false, host: '127.0.0.1', port: 9097, token: null });
  });
});

test('file storage can only be selected explicitly for isolated lab compatibility', async () => {
  await withEnv({ BIOMETRIC_STORAGE_MODE: 'file' }, async () => {
    const config = loadConfig('/tmp/biometric');
    assert.equal(config.storageMode, 'file');
    assert.equal(config.database, null);
    assert.equal(config.autoFinalizeNewPunches, false);
    assert.equal(config.admin.enabled, false);
  });
});


test('runtime hardening defaults bound logs and retry durable ingest while running', async () => {
  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret'
  }, async () => {
    const config = loadConfig('/tmp/biometric');
    assert.equal(config.database.retryDelaySeconds, 30);
    assert.equal(config.database.retrySweepSeconds, 10);
    assert.equal(config.logMaxBytes, 10 * 1024 * 1024);
    assert.equal(config.logRetainFiles, 5);
  });
});


test('automatic finalization of new punches can be disabled explicitly in database mode', async () => {
  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret',
    BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'false'
  }, async () => {
    const config = loadConfig('/tmp/biometric');
    assert.equal(config.autoFinalizeNewPunches, false);
  });
});

test('invalid automatic finalization flag fails closed', async () => {
  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret',
    BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'sometimes'
  }, async () => {
    assert.throws(() => loadConfig('/tmp/biometric'), /BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES must be true or false/);
  });
});


test('admin UI is deliberately loopback-only in v0.12.0', async () => {
  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret',
    BIOMETRIC_ADMIN_HOST: '0.0.0.0'
  }, async () => {
    assert.throws(() => loadConfig('/tmp/biometric'), /BIOMETRIC_ADMIN_HOST must remain loopback-only/);
  });
});

test('admin UI can be disabled without affecting device ingestion configuration', async () => {
  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret',
    BIOMETRIC_ADMIN_ENABLED: 'false'
  }, async () => {
    const config = loadConfig('/tmp/biometric');
    assert.equal(config.admin.enabled, false);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 9095);
  });
});


test('Final Events API is opt-in, loopback-only, and requires an independent strong token', async () => {
  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret',
    BIOMETRIC_FINAL_EVENTS_API_ENABLED: 'true',
    BIOMETRIC_FINAL_EVENTS_API_TOKEN: '0123456789abcdef0123456789abcdef'
  }, async () => {
    const config = loadConfig('/tmp/biometric');
    assert.deepEqual(config.finalEventsApi, {
      enabled: true, host: '127.0.0.1', port: 9097, token: '0123456789abcdef0123456789abcdef'
    });
  });

  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret',
    BIOMETRIC_FINAL_EVENTS_API_ENABLED: 'true',
    BIOMETRIC_FINAL_EVENTS_API_HOST: '0.0.0.0',
    BIOMETRIC_FINAL_EVENTS_API_TOKEN: '0123456789abcdef0123456789abcdef'
  }, async () => {
    assert.throws(() => loadConfig('/tmp/biometric'), /FINAL_EVENTS_API_HOST must remain loopback-only/);
  });

  await withEnv({
    BIOMETRIC_DB_HOST: 'db.example', BIOMETRIC_DB_USER: 'biometric', BIOMETRIC_DB_PASSWORD: 'secret',
    BIOMETRIC_FINAL_EVENTS_API_ENABLED: 'true',
    BIOMETRIC_FINAL_EVENTS_API_TOKEN: 'too-short'
  }, async () => {
    assert.throws(() => loadConfig('/tmp/biometric'), /FINAL_EVENTS_API_TOKEN must be at least 32 characters/);
  });
});
