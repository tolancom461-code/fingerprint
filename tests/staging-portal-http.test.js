import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { stagingPortalConfig } from '../src/config/staging-portal.js';
import { createStagingPortalHandler } from '../src/infrastructure/portal/server.js';
import { createHttpServer } from '../src/infrastructure/http/server.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';

const adminPassword = 'Test-admin-password!42';
const viewerPassword = 'Test-viewer-password!42';
const adminHash = await hashPassword(adminPassword);
const viewerHash = await hashPassword(viewerPassword);
const runtime = { storageMode: 'file', allowedDevices: [], admin: { enabled: false },
  finalEventsApi: { enabled: false }, webBridge: { enabled: false }, autoFinalizeNewPunches: false };

function environment(origin = 'https://portal.example') {
  return { BIOMETRIC_STAGING_PORTAL_ENABLED: 'true', BIOMETRIC_STAGING_PORTAL_ORIGIN: origin,
    BIOMETRIC_STAGING_ADMIN_USERNAME: 'admin-test', BIOMETRIC_STAGING_ADMIN_PASSWORD_HASH: adminHash,
    BIOMETRIC_STAGING_VIEWER_USERNAME: 'viewer-test', BIOMETRIC_STAGING_VIEWER_PASSWORD_HASH: viewerHash };
}

test('portal opt-in validates isolation and credentials without weakening local defaults', () => {
  assert.equal(stagingPortalConfig({}, {}), null);
  assert.equal(createStagingPortalHandler({ env: {}, runtime: {} }), null);
  assert.throws(() => stagingPortalConfig({ BIOMETRIC_STAGING_PORTAL_ENABLED: 'maybe' }, runtime));
  for (const override of [
    { storageMode: 'database' }, { allowedDevices: ['zkteco:REAL'] }, { admin: { enabled: true } },
    { finalEventsApi: { enabled: true } }, { webBridge: { enabled: true } }, { autoFinalizeNewPunches: true }
  ]) assert.throws(() => stagingPortalConfig(environment(), { ...runtime, ...override }), /isolated staging/);
  for (const origin of ['http://public.example', 'https://portal.example/path', 'https://user:pass@portal.example', 'https://portal.example?x=1']) {
    assert.throws(() => stagingPortalConfig(environment(origin), runtime), /HTTPS origin/);
  }
  assert.equal(stagingPortalConfig(environment(), runtime).users.length, 2);
  assert.throws(() => stagingPortalConfig({ ...environment(), BIOMETRIC_STAGING_ADMIN_PASSWORD_HASH: 'plaintext-not-a-hash' }, runtime), /valid portal password hash/);
  assert.throws(() => stagingPortalConfig({ ...environment(), BIOMETRIC_STAGING_VIEWER_USERNAME: 'ADMIN-TEST' }, runtime), /different/);
  assert.throws(() => stagingPortalConfig({ ...environment(), BIOMETRIC_STAGING_VIEWER_PASSWORD_HASH: '' }, runtime));
});

async function start(t) {
  let handler;
  const server = createHttpServer({ adapterRegistry: { match: () => null }, diagnosticLog: { async write() {} },
    portalHandler: (...args) => handler(...args) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createStagingPortalHandler({ env: environment(base), runtime });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base, async login(username, password) {
    const response = await fetch(base + '/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role: 'admin' }) });
    assert.equal(response.status, 200);
    const data = await response.json();
    return { data, cookie: response.headers.get('set-cookie').split(';')[0] };
  } };
}

test('portal protects documents and API, while health remains publicly available', async t => {
  const { base } = await start(t);
  const health = await fetch(base + '/health');
  assert.equal(await health.text(), 'OK');
  const root = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/login');
  const session = await fetch(base + '/auth/session');
  assert.equal(session.status, 401);
  const people = await fetch(base + '/api/portal/people');
  assert.equal(people.status, 401);
  const login = await fetch(base + '/login');
  assert.equal(login.status, 200);
  assert.ok(login.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.ok(!login.headers.get('content-security-policy').includes('unsafe-inline'));
  for (const asset of ['/portal.css', '/portal-login.js', '/portal-app.js']) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200, asset);
    await response.text();
  }
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(base + '/login', { headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(wrongHostStatus, 421);
});

test('manager can add a demo person only with a session, correct Origin and CSRF', async t => {
  const lab = await start(t);
  const login = await lab.login('admin-test', adminPassword);
  assert.equal(login.data.user.role, 'admin');
  assert.equal(login.data.mode, 'demo');
  const session = await fetch(lab.base + '/auth/session', { headers: { Cookie: login.cookie } });
  assert.equal((await session.json()).user.username, 'admin-test');
  const read = await fetch(lab.base + '/api/portal/devices', { headers: { Cookie: login.cookie } });
  const devices = await read.json();
  assert.ok(devices.items.length > 0);
  assert.ok(devices.items.every(x => x.status === 'not_connected' && x.lastSeenAt === null));
  const body = JSON.stringify({ personCode: 'DEMO-NEW', displayName: '<شخص تجريبي>' });
  const rejected = await fetch(lab.base + '/api/portal/people', { method: 'POST',
    headers: { Cookie: login.cookie, Origin: lab.base, 'Content-Type': 'application/json' }, body });
  assert.equal(rejected.status, 403);
  const badOrigin = await fetch(lab.base + '/api/portal/people', { method: 'POST',
    headers: { Cookie: login.cookie, Origin: 'https://other.example', 'Content-Type': 'application/json', 'X-CSRF-Token': login.data.csrfToken }, body });
  assert.equal(badOrigin.status, 403);
  const added = await fetch(lab.base + '/api/portal/people', { method: 'POST',
    headers: { Cookie: login.cookie, Origin: lab.base, 'Content-Type': 'application/json', 'X-CSRF-Token': login.data.csrfToken }, body });
  assert.equal(added.status, 201);
  assert.equal((await added.json()).person.personCode, 'DEMO-NEW');
  const found = await fetch(lab.base + '/api/portal/people?search=DEMO-NEW', { headers: { Cookie: login.cookie } });
  assert.equal((await found.json()).page.total, 1);
});

test('viewer can read and logout but cannot promote itself or add people', async t => {
  const lab = await start(t);
  const login = await lab.login('viewer-test', viewerPassword);
  assert.equal(login.data.user.role, 'viewer');
  const headers = { Cookie: login.cookie, Origin: lab.base, 'Content-Type': 'application/json', 'X-CSRF-Token': login.data.csrfToken };
  const read = await fetch(lab.base + '/api/portal/events?limit=2', { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).items.length, 2);
  const write = await fetch(lab.base + '/api/portal/people', { method: 'POST', headers,
    body: JSON.stringify({ personCode: 'DEMO-FORGED', displayName: 'تجربة', role: 'admin' }) });
  assert.equal(write.status, 403);
  const logout = await fetch(lab.base + '/auth/logout', { method: 'POST', headers, body: '{}' });
  assert.equal(logout.status, 200);
  const expired = await fetch(lab.base + '/api/portal/overview', { headers: { Cookie: login.cookie } });
  assert.equal(expired.status, 401);
});

test('portal rejects cross-origin login, malformed JSON and oversized bodies', async t => {
  const { base } = await start(t);
  const wrongOrigin = await fetch(base + '/auth/login', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(wrongOrigin.status, 403);
  const malformed = await fetch(base + '/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const oversize = await fetch(base + '/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(5000) }) });
  assert.equal(oversize.status, 413);
});
