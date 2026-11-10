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
  assert.equal(config.basicCredentials, null);
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

test('native Basic credentials are optional, explicit machine credentials and preserve the existing cloud defaults', () => {
  const username = 'fixture.device-1';
  const password = 'B'.repeat(48);
  const config = loadCloudIngestConfig({ ...environment(),
    BIOMETRIC_INGEST_BASIC_USERNAME: username, BIOMETRIC_INGEST_BASIC_PASSWORD: password });
  assert.deepEqual(config.basicCredentials, { username, password });
  assert.ok(Object.isFrozen(config.basicCredentials));
  assert.equal(config.token, token);
  assert.equal(config.autoFinalizeNewPunches, false);
  assert.equal(config.database.database, 'fingerprint');
  assert.equal(config.portal.users[0].username, 'fixture-admin');
  const minimum = loadCloudIngestConfig({ ...environment(),
    BIOMETRIC_INGEST_BASIC_USERNAME: 'p', BIOMETRIC_INGEST_BASIC_PASSWORD: 'B'.repeat(32) });
  assert.equal(minimum.basicCredentials.password.length, 32);
});

test('partial or blank Basic configuration fails closed and never reports configured credential values', () => {
  const secret = 'PRIVATE_CONFIG_SECRET_' + 'X'.repeat(32);
  const username = 'private-device';
  for (const changes of [
    { BIOMETRIC_INGEST_BASIC_USERNAME: username },
    { BIOMETRIC_INGEST_BASIC_PASSWORD: secret },
    { BIOMETRIC_INGEST_BASIC_USERNAME: username, BIOMETRIC_INGEST_BASIC_PASSWORD: '' },
    { BIOMETRIC_INGEST_BASIC_USERNAME: '', BIOMETRIC_INGEST_BASIC_PASSWORD: secret },
    { BIOMETRIC_INGEST_BASIC_USERNAME: '', BIOMETRIC_INGEST_BASIC_PASSWORD: '' },
    { BIOMETRIC_INGEST_BASIC_USERNAME: undefined },
    { BIOMETRIC_INGEST_BASIC_PASSWORD: undefined }
  ]) {
    assert.throws(() => loadCloudIngestConfig({ ...environment(), ...changes }), error => {
      assert.equal(error.code, 'CLOUD_INGEST_CONFIG_INVALID');
      assert.equal(error.message, 'Invalid cloud ingest configuration');
      assert.equal(error.cause, undefined);
      for (const value of [username, secret]) assert.equal(String(error.stack).includes(value), false);
      return true;
    });
  }
});

test('weak, non-ASCII and URI-delimiter Basic credentials are rejected instead of normalized or accepted', () => {
  const valid = { BIOMETRIC_INGEST_BASIC_USERNAME: 'fixture-device', BIOMETRIC_INGEST_BASIC_PASSWORD: 'B'.repeat(48) };
  for (const changes of [
    { BIOMETRIC_INGEST_BASIC_USERNAME: 'p', BIOMETRIC_INGEST_BASIC_PASSWORD: 'p' },
    { BIOMETRIC_INGEST_BASIC_PASSWORD: 'B'.repeat(31) },
    { BIOMETRIC_INGEST_BASIC_PASSWORD: 'B'.repeat(129) },
    { BIOMETRIC_INGEST_BASIC_USERNAME: 'device:other' },
    { BIOMETRIC_INGEST_BASIC_USERNAME: 'device@example' },
    { BIOMETRIC_INGEST_BASIC_USERNAME: ' device' },
    { BIOMETRIC_INGEST_BASIC_USERNAME: 'جهاز' },
    { BIOMETRIC_INGEST_BASIC_PASSWORD: 'B'.repeat(32) + '%2F' },
    { BIOMETRIC_INGEST_BASIC_PASSWORD: 'B'.repeat(32) + '\n' },
    { BIOMETRIC_INGEST_BASIC_PASSWORD: null }
  ]) rejects({ ...valid, ...changes });
});

test('portal, staging, database and generic Basic values cannot fill either machine Basic field', () => {
  const password = 'B'.repeat(48);
  const aliases = { BIOMETRIC_PORTAL_ADMIN_USERNAME: 'portal-device',
    BIOMETRIC_STAGING_ADMIN_USERNAME: 'staging-device', BIOMETRIC_STAGING_ADMIN_PASSWORD: password,
    BIOMETRIC_INGEST_DB_USER: 'fixture.database-device', BIOMETRIC_INGEST_DB_PASSWORD: password,
    BIOMETRIC_BASIC_USERNAME: 'generic-device', BIOMETRIC_BASIC_PASSWORD: password };
  const config = loadCloudIngestConfig({ ...environment(), ...aliases });
  assert.equal(config.basicCredentials, null);
  rejects({ ...aliases, BIOMETRIC_INGEST_BASIC_USERNAME: 'fixture-device' });
  rejects({ ...aliases, BIOMETRIC_INGEST_BASIC_PASSWORD: password });
});
