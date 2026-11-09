import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashPassword } from '../src/infrastructure/portal/auth.js';
import { loadStandalonePortalConfig } from '../src/config/standalone-portal.js';
import { railwayMode } from '../src/config/railway-mode.js';

const hash = await hashPassword('Standalone-config-fixture-2026!');
function environment() {
  return { BIOMETRIC_PORTAL_DB_HOST: 'db.example', BIOMETRIC_PORTAL_DB_PORT: '4000',
    BIOMETRIC_PORTAL_DB_USER: 'fixture_reader', BIOMETRIC_PORTAL_DB_PASSWORD: 'unit-db-secret',
    BIOMETRIC_PORTAL_DB_NAME: 'fingerprint', BIOMETRIC_PORTAL_DB_CONFIRMED_NAME: 'fingerprint',
    BIOMETRIC_PORTAL_ORIGIN: 'https://portal.example', BIOMETRIC_PORTAL_ADMIN_USERNAME: 'unit-admin',
    BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH: hash };
}
function rejects(changes) {
  assert.throws(() => loadStandalonePortalConfig({ ...environment(), ...changes }), { code: 'STANDALONE_PORTAL_CONFIG_INVALID' });
}

test('real portal pins the explicit standalone profile and confirmed fingerprint database without a fixture identity', () => {
  const config = loadStandalonePortalConfig(environment());
  assert.equal(config.database.profile, 'standalone-readonly');
  assert.equal(config.database.database, 'fingerprint');
  assert.equal(config.database.confirmedName, 'fingerprint');
  assert.equal('instanceId' in config.database, false);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8080);
  assert.equal(config.database.sslMode, 'required');
  assert.equal(config.database.connectionLimit, 3);
  for (const value of [config, config.database, config.portal, config.portal.users, config.portal.users[0]]) assert.ok(Object.isFrozen(value));
  for (const database of ['test', 'tolanhr', 'Fingerprint', 'biometric_portal_test_unit', 'fingerprint ']) {
    rejects({ BIOMETRIC_PORTAL_DB_NAME: database, BIOMETRIC_PORTAL_DB_CONFIRMED_NAME: database });
  }
  for (const confirmation of [undefined, '', 'test', ' fingerprint', 'fingerprint ']) rejects({ BIOMETRIC_PORTAL_DB_CONFIRMED_NAME: confirmation });
});

test('standalone configuration reads only its namespace and cannot inherit source, fixture, demo or writer configuration', () => {
  const values = environment();
  const permitted = new Set([...Object.keys(values), 'PORT', 'BIOMETRIC_PORTAL_HOST', 'BIOMETRIC_PORTAL_DB_SSL_MODE',
    'BIOMETRIC_PORTAL_DB_CONNECT_TIMEOUT_MS', 'BIOMETRIC_PORTAL_DB_QUERY_TIMEOUT_MS',
    'BIOMETRIC_PORTAL_VIEWER_USERNAME', 'BIOMETRIC_PORTAL_VIEWER_PASSWORD_HASH']);
  const config = loadStandalonePortalConfig(new Proxy(values, { get(target, key) {
    assert.ok(permitted.has(key), `Unexpected environment access: ${String(key)}`);
    return target[key];
  } }));
  assert.equal(config.database.user, values.BIOMETRIC_PORTAL_DB_USER);
  assert.throws(() => loadStandalonePortalConfig({
    TIDB_SOURCE_HOST: 'source.invalid', TIDB_SOURCE_PASSWORD: 'do-not-use-source',
    BIOMETRIC_DB_NAME: 'test', BIOMETRIC_TEST_DB_NAME: 'fingerprint',
    BIOMETRIC_STAGING_ADMIN_PASSWORD_HASH: hash
  }), { code: 'STANDALONE_PORTAL_CONFIG_INVALID' });
  const poisoned = loadStandalonePortalConfig({ ...values, BIOMETRIC_ALLOWED_DEVICES: 'zkteco:REAL',
    BIOMETRIC_WEB_BRIDGE_ENABLED: 'true', BIOMETRIC_STORAGE_MODE: 'database', BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'true' });
  assert.deepEqual(poisoned, config);
});

test('remote TLS, bounded numeric settings and credential-preserving configuration fail closed', () => {
  rejects({ BIOMETRIC_PORTAL_DB_SSL_MODE: 'disabled' });
  for (const host of ['user@db.example', 'mysql://db.example', 'db.example/path', 'db\n.example']) rejects({ BIOMETRIC_PORTAL_DB_HOST: host });
  for (const port of ['0', '65536', '8080tail', ' 8080', '-1']) rejects({ PORT: port });
  for (const timeout of ['99', '10001', '500ms']) rejects({ BIOMETRIC_PORTAL_DB_QUERY_TIMEOUT_MS: timeout });
  const password = '  intentional spaces % # $  ';
  assert.equal(loadStandalonePortalConfig({ ...environment(), BIOMETRIC_PORTAL_DB_PASSWORD: password }).database.password, password);
  rejects({ BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH: 'invalid-secret' });
  rejects({ BIOMETRIC_PORTAL_ORIGIN: 'http://public.example' });
  rejects({ BIOMETRIC_PORTAL_VIEWER_USERNAME: 'viewer-alone' });
  const local = loadStandalonePortalConfig({ ...environment(), BIOMETRIC_PORTAL_DB_HOST: '127.0.0.1',
    BIOMETRIC_PORTAL_DB_SSL_MODE: 'disabled', BIOMETRIC_PORTAL_ORIGIN: 'http://127.0.0.1:8080' });
  assert.equal(local.database.sslMode, 'disabled');
});

test('Railway runtime choice is explicit and invalid modes never fall back to demo or a writer', () => {
  assert.equal(railwayMode({}), 'demo');
  assert.equal(railwayMode({ BIOMETRIC_RAILWAY_MODE: 'demo' }), 'demo');
  assert.equal(railwayMode({ BIOMETRIC_RAILWAY_MODE: 'database-readonly' }), 'database-readonly');
  for (const mode of ['', 'production', 'database', 'database-readonly ', true]) {
    assert.throws(() => railwayMode({ BIOMETRIC_RAILWAY_MODE: mode }), { code: 'RAILWAY_MODE_INVALID' });
  }
});

test('actual standalone CLI fails without credentials and prints no secrets or stack traces', async () => {
  try {
    await promisify(execFile)(process.execPath, ['src/portal-database.js'], { cwd: new URL('..', import.meta.url),
      windowsHide: true, timeout: 5000, env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
        BIOMETRIC_PORTAL_DB_PASSWORD: 'never-print-this-value', BIOMETRIC_DB_NAME: 'test' } });
    assert.fail('unconfigured runtime must fail');
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /STANDALONE_PORTAL_CONFIG_INVALID/);
    assert.doesNotMatch(error.stderr, /never-print-this-value|\bat .*\.js/);
  }
});
