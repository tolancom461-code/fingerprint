import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startReadOnlyPortal } from '../src/infrastructure/portal/read-only-runtime.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';

const password = 'Test-runtime-only-password!2026';
const passwordHash = await hashPassword(password);
function settings(port = 0) {
  return { host: '127.0.0.1', port, database: { database: 'biometric_portal_test_unit' },
    portal: { origin: 'http://127.0.0.1:8081', users: [{ username: 'fixture-admin', passwordHash, role: 'admin' }] } };
}
function fakeDatabase() {
  let available = true;
  const calls = [];
  let ends = 0;
  return { calls, get ends() { return ends; }, available(value) { available = value; },
    async checkReady() { if (!available) throw new Error('private database host details'); },
    async execute(sql) {
      calls.push(sql);
      if (!available) throw new Error('private database host details');
      if (sql.includes('COUNT(*)')) return [[{ total: 1, active: 1, test_mode: 1 }]];
      if (sql.includes('FROM `biometric_svc_people` p')) return [[{ id: '42', person_code: 'TEST-42', display_name: 'شخص اختبار', status: 'active' }]];
      return [[]];
    },
    async end() { ends++; }
  };
}
async function start(t, database = fakeDatabase()) {
  // Reserve a loopback port to match the canonical portal origin without exposing a second listener.
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const config = settings(port);
  config.portal.origin = `http://127.0.0.1:${port}`;
  const runtime = await startReadOnlyPortal({ config, openDatabase: async selected => {
    assert.equal(selected, config.database);
    return database;
  } });
  t.after(() => runtime.close());
  return { runtime, database, base: config.portal.origin };
}

test('test runtime separates liveness from database readiness and recovers without a process restart', async t => {
  const lab = await start(t);
  assert.equal(await (await fetch(lab.base + '/health')).text(), 'OK');
  assert.equal((await fetch(lab.base + '/ready')).status, 200);
  lab.database.available(false);
  const failed = await fetch(lab.base + '/ready');
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { status: 'unavailable', mode: 'database-readonly' });
  assert.equal((await fetch(lab.base + '/health')).status, 200);
  lab.database.available(true);
  assert.equal((await fetch(lab.base + '/ready')).status, 200);
});

test('runtime mounts protected database reads and cannot route devices, delivery or legacy administration', async t => {
  const lab = await start(t);
  for (const route of ['/iclock/cdata?SN=TEST-ONLY', '/api/overview', '/api/v1/final-events']) {
    const response = await fetch(lab.base + route);
    assert.equal(response.status, 404);
    await response.text();
  }
  assert.equal((await fetch(lab.base + '/api/portal/people')).status, 401);
  assert.deepEqual(lab.database.calls, []);
  const login = await fetch(lab.base + '/auth/login', { method: 'POST', headers: { Origin: lab.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'fixture-admin', password }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.equal(session.mode, 'database-readonly');
  assert.deepEqual(session.capabilities, { createPerson: false });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: lab.base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken };
  const people = await fetch(lab.base + '/api/portal/people?limit=10', { headers });
  assert.equal(people.status, 200);
  assert.equal((await people.json()).items[0].personCode, 'TEST-42');
  const write = await fetch(lab.base + '/api/portal/people', { method: 'POST', headers, body: JSON.stringify({ personCode: 'TEST-43', displayName: 'اختبار' }) });
  assert.equal(write.status, 403);
  assert.equal((await write.json()).error, 'READ_ONLY');
  assert.ok(lab.database.calls.every(sql => /^\s*SELECT\b/i.test(sql)));
});

test('database initialization failure prevents creation of a listening portal', async () => {
  const failure = Object.assign(new Error('safe failure'), { code: 'TEST_FAILURE' });
  await assert.rejects(startReadOnlyPortal({ config: settings(), openDatabase: async () => { throw failure; } }), error => error === failure);
});

test('handler configuration and listen failures close the database without exposing details', async () => {
  const database = fakeDatabase();
  const config = settings();
  config.portal.users[0].passwordHash = 'invalid-hash';
  await assert.rejects(startReadOnlyPortal({ config, openDatabase: async () => database }), { code: 'READ_PORTAL_START_FAILED' });
  assert.equal(database.ends, 1);
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const another = fakeDatabase();
    await assert.rejects(startReadOnlyPortal({ config: settings(occupied.address().port), openDatabase: async () => another }), { code: 'READ_PORTAL_START_FAILED' });
    assert.equal(another.ends, 1);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('runtime close is idempotent and releases its listener and pool', async t => {
  const lab = await start(t);
  await Promise.all([lab.runtime.close(), lab.runtime.close()]);
  assert.equal(lab.database.ends, 1);
  await assert.rejects(fetch(lab.base + '/health', { signal: AbortSignal.timeout(1000) }));
});

test('CLI configuration failure is bounded and prints no environment values or stack', async () => {
  const environment = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    BIOMETRIC_DB_PASSWORD: 'private-production-password', BIOMETRIC_DB_HOST: 'private-production-host' };
  try {
    await promisify(execFile)(process.execPath, ['src/test-portal.js'], { cwd: new URL('..', import.meta.url), env: environment,
      windowsHide: true, timeout: 5000 });
    assert.fail('unconfigured CLI should fail');
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /READ_PORTAL_CONFIG_INVALID/);
    assert.doesNotMatch(error.stderr, /private-production|\bat .*\.js/);
  }
});
