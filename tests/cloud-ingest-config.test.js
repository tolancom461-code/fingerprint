import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/infrastructure/portal/auth.js';
import { loadCloudIngestConfig } from '../src/config/cloud-ingest.js';
import { railwayMode } from '../src/config/railway-mode.js';

const hash = await hashPassword('Cloud-config-only-password!2026');
const token = 'a'.repeat(64);
function environment() {
  return { PORT: '8080', BIOMETRIC_INGEST_DB_HOST: 'db.example', BIOMETRIC_INGEST_DB_PORT: '4000',
    BIOMETRIC_INGEST_DB_USER: 'fixture.writer', BIOMETRIC_INGEST_DB_PASSWORD: 'not-a-real-password',
    BIOMETRIC_INGEST_DB_NAME: 'fingerprint', BIOMETRIC_INGEST_DB_CONFIRMED_NAME: 'fingerprint',
    BIOMETRIC_INGEST_TOKEN: token, BIOMETRIC_INGEST_ALLOWED_DEVICES: 'zkteco:FIXTURE-1',
    BIOMETRIC_PORTAL_ORIGIN: 'https://portal.example', BIOMETRIC_PORTAL_ADMIN_USERNAME: 'fixture-admin',
    BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH: hash };
}
const rejects = changes => assert.throws(() => loadCloudIngestConfig({ ...environment(), ...changes }), { code: 'CLOUD_INGEST_CONFIG_INVALID' });

test('cloud ingest explicitly selects fingerprint and a distinct writer with automatic finalization disabled', () => {
  const config = loadCloudIngestConfig(environment());
  assert.equal(config.database.database, 'fingerprint');
  assert.equal(config.database.confirmedName, 'fingerprint');
  assert.equal(config.database.sslMode, 'required');
  assert.equal(config.autoFinalizeNewPunches, false);
  assert.equal(config.token, token);
  assert.deepEqual(config.allowedDevices, ['zkteco:FIXTURE-1']);
  assert.equal(config.port, 8080);
  for (const value of [config, config.database, config.portal, config.allowedDevices, config.adms]) assert.ok(Object.isFrozen(value));
  assert.equal(railwayMode({ BIOMETRIC_RAILWAY_MODE: 'database-ingest' }), 'database-ingest');
  for (const database of ['test', 'Fingerprint', 'other', 'fingerprint ']) rejects({ BIOMETRIC_INGEST_DB_NAME: database, BIOMETRIC_INGEST_DB_CONFIRMED_NAME: database });
  rejects({ BIOMETRIC_INGEST_DB_CONFIRMED_NAME: '' });
  for (const user of ['root', 'tenant.root']) rejects({ BIOMETRIC_INGEST_DB_USER: user });
});

test('legacy, source, demo and read-only credentials never fill the ingest namespace or activate outbound consumers', () => {
  assert.throws(() => loadCloudIngestConfig({ BIOMETRIC_DB_NAME: 'test', DATABASE_URL: 'mysql://unused.invalid/test',
    TIDB_SETUP_PASSWORD: 'unused', BIOMETRIC_PORTAL_DB_PASSWORD: 'reader', BIOMETRIC_STAGING_ADMIN_PASSWORD_HASH: hash }), { code: 'CLOUD_INGEST_CONFIG_INVALID' });
  const clean = loadCloudIngestConfig(environment());
  assert.deepEqual(loadCloudIngestConfig({ ...environment(), BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'true',
    BIOMETRIC_WEB_BRIDGE_ENABLED: 'true', BIOMETRIC_ADMIN_ENABLED: 'true', BIOMETRIC_DB_NAME: 'test',
    TIDB_SOURCE_PASSWORD: 'must-not-inherit' }), clean);
  assert.ok(!('webBridge' in clean) && !('finalEventsApi' in clean));
});

test('authentication, allowlist, remote TLS and safe intake bounds fail closed', () => {
  for (const value of ['', 'short', 'a'.repeat(42), 'a'.repeat(129), 'b '.repeat(32)]) rejects({ BIOMETRIC_INGEST_TOKEN: value });
  for (const value of ['', 'zkteco:', 'zkteco:A,zkteco:A', 'other:A', 'zkteco:A, zkteco:B', 'zkteco:A?token=secret']) rejects({ BIOMETRIC_INGEST_ALLOWED_DEVICES: value });
  rejects({ BIOMETRIC_INGEST_AUTO_FINALIZE_NEW_PUNCHES: 'true' });
  rejects({ BIOMETRIC_INGEST_DB_SSL_MODE: 'disabled' });
  rejects({ BIOMETRIC_INGEST_DB_HOST: 'mysql://user:password@db.example' });
  for (const value of ['0', '65536', '8080suffix']) rejects({ PORT: value });
  rejects({ BIOMETRIC_INGEST_MAX_BODY_BYTES: '524289' });
  rejects({ BIOMETRIC_INGEST_DB_TRANSACTION_TIMEOUT_MS: '30001' });
  const local = loadCloudIngestConfig({ ...environment(), BIOMETRIC_INGEST_DB_HOST: '127.0.0.1', BIOMETRIC_INGEST_DB_SSL_MODE: 'disabled',
    BIOMETRIC_PORTAL_ORIGIN: 'http://127.0.0.1:8080' });
  assert.equal(local.database.sslMode, 'disabled');
});
