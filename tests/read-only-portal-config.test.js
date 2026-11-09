import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReadOnlyPortalConfig } from '../src/config/read-only-portal.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';

const hash = await hashPassword('Test-config-only-password!2026');
function environment() {
  return { BIOMETRIC_TEST_DB_HOST: '127.0.0.1', BIOMETRIC_TEST_DB_PORT: '3307', BIOMETRIC_TEST_DB_USER: 'fixture_reader',
    BIOMETRIC_TEST_DB_PASSWORD: 'fixture-database-only', BIOMETRIC_TEST_DB_NAME: 'biometric_portal_test_unit',
    BIOMETRIC_TEST_DB_SSL_MODE: 'disabled', BIOMETRIC_TEST_DB_INSTANCE_ID: '48d47491-e7bf-4af5-b617-f361f193f5c4',
    BIOMETRIC_READ_PORTAL_ORIGIN: 'http://127.0.0.1:8081', BIOMETRIC_READ_PORTAL_ADMIN_USERNAME: 'fixture-admin',
    BIOMETRIC_READ_PORTAL_ADMIN_PASSWORD_HASH: hash };
}
function rejects(overrides) {
  assert.throws(() => loadReadOnlyPortalConfig({ ...environment(), ...overrides }), { code: 'READ_PORTAL_CONFIG_INVALID' });
}

test('read-only test configuration is immutable and has separate credentials and loopback defaults', () => {
  const config = loadReadOnlyPortalConfig(environment());
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8081);
  assert.equal(config.database.database, 'biometric_portal_test_unit');
  assert.equal(config.database.port, 3307);
  assert.equal(config.portal.users[0].role, 'admin');
  assert.equal(config.database.connectionLimit, 3);
  for (const value of [config, config.database, config.portal, config.portal.users, config.portal.users[0]]) assert.ok(Object.isFrozen(value));
});

test('production and demo environment variables cannot activate or fill the read-only test configuration', () => {
  assert.throws(() => loadReadOnlyPortalConfig({ BIOMETRIC_DB_HOST: 'production.invalid', BIOMETRIC_DB_USER: 'production',
    BIOMETRIC_DB_PASSWORD: 'production-secret', BIOMETRIC_DB_NAME: 'test', BIOMETRIC_STAGING_PORTAL_ENABLED: 'true',
    BIOMETRIC_STAGING_ADMIN_PASSWORD_HASH: hash }), { code: 'READ_PORTAL_CONFIG_INVALID' });
  const config = loadReadOnlyPortalConfig({ ...environment(), BIOMETRIC_ALLOWED_DEVICES: 'test-vendor:ANY',
    BIOMETRIC_WEB_BRIDGE_ENABLED: 'true', BIOMETRIC_ADMIN_ENABLED: 'true', BIOMETRIC_DB_HOST: 'production.invalid' });
  assert.equal(config.database.host, '127.0.0.1');
  assert.equal('allowedDevices' in config, false);
  assert.equal('webBridge' in config, false);
});

test('database selection requires a deliberate test name and canonical UUID v4 identity', () => {
  for (const database of ['test', 'tolanhr', 'biometric_service', 'biometric_portal_test_', 'biometric_portal_test_a;DROP', 'biometric_portal_test_' + 'a'.repeat(33)]) {
    rejects({ BIOMETRIC_TEST_DB_NAME: database });
  }
  for (const id of ['', 'not-a-uuid', '48d47491-e7bf-1af5-b617-f361f193f5c4']) rejects({ BIOMETRIC_TEST_DB_INSTANCE_ID: id });
});

test('fingerprint requires an exact explicit confirmation and cannot authorize other database names', () => {
  const config = loadReadOnlyPortalConfig({ ...environment(), BIOMETRIC_TEST_DB_NAME: 'fingerprint',
    BIOMETRIC_TEST_DB_CONFIRMED_NAME: 'fingerprint' });
  assert.equal(config.database.database, 'fingerprint');
  assert.equal(config.database.confirmedName, 'fingerprint');
  for (const confirmation of [undefined, '', 'Fingerprint', ' fingerprint', 'fingerprint ', 'test', true]) {
    rejects({ BIOMETRIC_TEST_DB_NAME: 'fingerprint', BIOMETRIC_TEST_DB_CONFIRMED_NAME: confirmation });
  }
  for (const database of ['test', 'tolanhr', 'production', 'Fingerprint', 'fingerprint_other']) {
    rejects({ BIOMETRIC_TEST_DB_NAME: database, BIOMETRIC_TEST_DB_CONFIRMED_NAME: database });
  }
  assert.equal(loadReadOnlyPortalConfig(environment()).database.database, 'biometric_portal_test_unit');
});

test('TLS is mandatory for remote databases and connection host input cannot embed credentials or a URI', () => {
  const remote = { ...environment(), BIOMETRIC_TEST_DB_HOST: 'database.example', BIOMETRIC_TEST_DB_SSL_MODE: undefined };
  assert.equal(loadReadOnlyPortalConfig(remote).database.sslMode, 'required');
  rejects({ BIOMETRIC_TEST_DB_HOST: 'database.example', BIOMETRIC_TEST_DB_SSL_MODE: 'disabled' });
  for (const host of ['mysql://database.example', 'user@database.example', 'database.example/path', 'db\n.example']) rejects({ BIOMETRIC_TEST_DB_HOST: host });
});

test('ports and timeouts reject partial strings and stay within bounded ranges', () => {
  for (const port of ['0', '65536', '-1', '8081tail', ' 8081']) rejects({ PORT: port });
  for (const port of ['0', '3307tail']) rejects({ BIOMETRIC_TEST_DB_PORT: port });
  for (const duration of ['99', '10001', '500ms']) {
    rejects({ BIOMETRIC_TEST_DB_CONNECT_TIMEOUT_MS: duration });
    rejects({ BIOMETRIC_TEST_DB_QUERY_TIMEOUT_MS: duration });
  }
  rejects({ BIOMETRIC_READ_PORTAL_HOST: 'remote.example' });
  assert.equal(loadReadOnlyPortalConfig({ ...environment(), BIOMETRIC_READ_PORTAL_HOST: '0.0.0.0' }).host, '0.0.0.0');
});

test('portal credentials fail closed and configuration errors never echo supplied secret values', () => {
  for (const change of [
    { BIOMETRIC_READ_PORTAL_ADMIN_PASSWORD_HASH: '' }, { BIOMETRIC_READ_PORTAL_ADMIN_PASSWORD_HASH: 'invalid-secret-hash' },
    { BIOMETRIC_READ_PORTAL_ORIGIN: 'http://public.example' }, { BIOMETRIC_READ_PORTAL_ORIGIN: 'https://user:secret@public.example' },
    { BIOMETRIC_READ_PORTAL_VIEWER_USERNAME: 'viewer-without-hash' },
    { BIOMETRIC_READ_PORTAL_VIEWER_USERNAME: 'FIXTURE-ADMIN', BIOMETRIC_READ_PORTAL_VIEWER_PASSWORD_HASH: hash }
  ]) rejects(change);
  try { loadReadOnlyPortalConfig({ ...environment(), BIOMETRIC_TEST_DB_PASSWORD: 'do-not-echo-this', BIOMETRIC_TEST_DB_NAME: 'private-production-name' }); }
  catch (error) { assert.doesNotMatch(error.message, /do-not-echo-this|private-production-name/); }
  const secret = '  intentional-password-spaces  ';
  assert.equal(loadReadOnlyPortalConfig({ ...environment(), BIOMETRIC_TEST_DB_PASSWORD: secret }).database.password, secret);
});
