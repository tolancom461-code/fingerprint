import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startCloudIngest } from '../src/infrastructure/ingest/cloud-runtime.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';

const token = 'c'.repeat(64);
const password = 'Synthetic-cloud-portal-password!2026';
const passwordHash = await hashPassword(password);
const privateText = 'PRIVATE_PIN_NAME_AND_PAYLOAD';

function fakeDatabase() {
  const state = { calls: [], checks: 0, ended: 0, available: true, flagAvailable: true, failWrite: false };
  const database = {
    async checkReady() {
      state.checks++;
      if (!state.available) throw new Error(privateText + token);
      return { ready: true };
    },
    async execute(sql, params = []) {
      state.calls.push({ sql, params });
      if (!state.available || (state.failWrite && /^\s*INSERT/.test(sql))) throw new Error(privateText + token);
      if (sql.includes('DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT')) return [state.flagAvailable ? [
        { DATA_TYPE: 'tinyint', COLUMN_TYPE: 'tinyint unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' }
      ] : [], []];
      if (/^\s*SELECT i\.\*/.test(sql)) return [[], []];
      if (/^\s*INSERT INTO `biometric_svc_devices`/.test(sql)) return [{ insertId: '1', affectedRows: 1 }, []];
      if (sql.includes('FROM `biometric_svc_devices`') && sql.includes('WHERE vendor = ?')) return [[{
        id: '1', vendor: 'zkteco', serial_number: 'TEST-DEVICE', status: 'active', mode: 'test', timezone: 'Asia/Riyadh', accept_events_from: null
      }], []];
      if (/\bCOUNT\(\*\)/.test(sql)) return [[{ total: 0, active: 0, test_mode: 0, received: 0, device_users: 0 }], []];
      if (/^\s*SELECT\b/.test(sql)) return [[], []];
      throw new Error('Unexpected synthetic pipeline write');
    },
    async getConnection() { throw new Error('No ATTLOG transaction belongs in these HTTP boundary fixtures'); },
    async end() { state.ended++; }
  };
  return { database, state };
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function configuration(port) {
  return { host: '127.0.0.1', port, token, allowedDevices: ['zkteco:TEST-DEVICE'],
    portal: { origin: `http://127.0.0.1:${port}`, users: [{ username: 'test-admin', passwordHash, role: 'admin' }] },
    database: { synthetic: true }, maxBodyBytes: 1024, autoFinalizeNewPunches: false,
    retrySweepSeconds: 1, retryDelaySeconds: 1, replayLimit: 1000,
    adms: { delaySeconds: 10, errorDelaySeconds: 60, realtime: 1, encrypt: 0 } };
}
async function start(t, { includeViewer = false, retrySweepSeconds = 1, basicCredentials } = {}) {
  const fixture = fakeDatabase();
  const logs = [];
  const config = configuration(await freePort());
  config.retrySweepSeconds = retrySweepSeconds;
  if (basicCredentials !== undefined) config.basicCredentials = basicCredentials;
  if (includeViewer) config.portal.users.push({ username: 'test-viewer', passwordHash, role: 'viewer' });
  const runtime = await startCloudIngest({ config, openDatabase: async settings => {
    assert.equal(settings, config.database); return fixture.database;
  }, diagnosticLog: { async write(entry) { logs.push(entry); } } });
  t.after(() => runtime.close());
  return { ...fixture, logs, config, runtime, base: config.portal.origin };
}
function writes(state) { return state.calls.filter(call => !/^\s*SELECT\b/.test(call.sql)); }
function basicAuthorization(username, value) { return `Basic ${Buffer.from(`${username}:${value}`, 'ascii').toString('base64')}`; }
async function login(lab, username = 'test-admin') {
  const response = await fetch(lab.base + '/auth/login', { method: 'POST',
    headers: { Origin: lab.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200);
  return { data: await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
}

test('anonymous GET/POST and session or query credentials cannot reach machine storage; valid machine credentials still require an allowed serial', async t => {
  const lab = await start(t);
  const session = await login(lab);
  for (const method of ['GET', 'POST']) {
    for (const headers of [{}, { Cookie: session.cookie }, { Authorization: `Bearer ${'d'.repeat(64)}` }]) {
      const response = await fetch(lab.base + `/iclock/cdata?SN=TEST-DEVICE&token=${token}&table=ATTLOG`, {
        method, headers, ...(method === 'POST' ? { body: privateText } : {}) });
      assert.equal(response.status, 401); await response.text();
    }
  }
  assert.deepEqual(writes(lab.state), []);
  const unknown = await fetch(lab.base + '/iclock/cdata?SN=UNKNOWN', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(unknown.status, 403); await unknown.text();
  assert.deepEqual(writes(lab.state), []);
  const known = await fetch(lab.base + '/iclock/cdata?SN=TEST-DEVICE', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(known.status, 200);
  assert.match(await known.text(), /GET OPTION FROM: TEST-DEVICE/);
  assert.equal(writes(lab.state).length, 1);
  const logText = JSON.stringify(lab.logs);
  for (const value of [token, privateText, 'TEST-DEVICE', 'UNKNOWN']) assert.equal(logText.includes(value), false);
});

test('the ingest listener keeps portal reads authenticated and rejects portal writes and legacy administration/integration routes', async t => {
  const lab = await start(t);
  for (const route of ['/api/portal/overview', '/api/portal/received-punches', '/api/portal/device-users']) {
    const response = await fetch(lab.base + route, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401); await response.text();
  }
  const session = await login(lab);
  assert.equal(session.data.mode, 'database-ingest');
  assert.equal(session.data.capabilities.createPerson, false);
  assert.equal(session.data.capabilities.receivedRecords, true);
  const headers = { Cookie: session.cookie, Origin: lab.base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.data.csrfToken };
  const overview = await fetch(lab.base + '/api/portal/overview', { headers });
  assert.equal(overview.status, 200); await overview.json();
  const write = await fetch(lab.base + '/api/portal/people', { method: 'POST', headers,
    body: JSON.stringify({ personCode: 'SYNTHETIC', displayName: privateText }) });
  assert.equal(write.status, 403); await write.text();
  for (const route of ['/api/overview', '/api/devices', '/api/v1/final-events', '/api/biometric-bridge/v1/final-events']) {
    const response = await fetch(lab.base + route, { headers });
    assert.equal(response.status, 404); await response.text();
  }
  assert.deepEqual(writes(lab.state), []);
});

test('body limits and pipeline errors return safe responses without placing payloads, credentials or request fields into diagnostics', async t => {
  const lab = await start(t);
  const headers = { Authorization: `Bearer ${token}` };
  const oversized = await fetch(lab.base + '/iclock/cdata?SN=TEST-DEVICE&table=ATTLOG', {
    method: 'POST', headers, body: privateText.repeat(100) });
  assert.equal(oversized.status, 413); await oversized.text();
  assert.ok(writes(lab.state).every(call => call.sql.includes('biometric_svc_devices')));
  const options = await fetch(lab.base + `/iclock/cdata?SN=TEST-DEVICE&table=OPTIONS&private=${token}`, {
    method: 'POST', headers: { ...headers, 'User-Agent': privateText },
    body: `~DeviceName=${privateText},CommKey=${token}` });
  assert.equal(options.status, 200); await options.text();
  lab.state.failWrite = true;
  const failed = await fetch(lab.base + '/iclock/cdata?SN=TEST-DEVICE', { headers });
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), 'ERROR');
  const logText = JSON.stringify(lab.logs);
  for (const value of [token, privateText, 'authorization', 'headers', 'query', 'message', 'CommKey']) assert.equal(logText.includes(value), false);
});

test('readiness tracks database failure and recovery while liveness stays available; close is idempotent', async t => {
  const lab = await start(t);
  let response = await fetch(lab.base + '/ready');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready', mode: 'database-ingest' });
  lab.state.available = false;
  response = await fetch(lab.base + '/ready');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable', mode: 'database-ingest' });
  assert.equal(await (await fetch(lab.base + '/health')).text(), 'OK');
  lab.state.available = true;
  response = await fetch(lab.base + '/ready');
  assert.equal(response.status, 200); await response.text();
  await Promise.all([lab.runtime.close(), lab.runtime.close()]);
  assert.equal(lab.state.ended, 1);
  await assert.rejects(fetch(lab.base + '/health', { signal: AbortSignal.timeout(1000) }));
});

test('initial guard/init and listen failures close resources before returning a sanitized startup failure', async () => {
  const fixture = fakeDatabase();
  const config = configuration(await freePort());
  fixture.state.available = false;
  await assert.rejects(startCloudIngest({ config, openDatabase: async () => fixture.database,
    diagnosticLog: { async write() {} } }), error => {
    assert.equal(error.code, 'CLOUD_INGEST_START_FAILED');
    assert.equal((error.stack + JSON.stringify(error)).includes(privateText), false);
    assert.equal(error.cause, undefined); return true;
  });
  assert.equal(fixture.state.ended, 1);
  assert.deepEqual(writes(fixture.state), []);
  const missing = fakeDatabase();
  missing.state.flagAvailable = false;
  await assert.rejects(startCloudIngest({ config: { ...config, autoFinalizeNewPunches: true }, openDatabase: async () => missing.database,
    diagnosticLog: { async write() {} } }), { code: 'CLOUD_INGEST_START_FAILED' });
  assert.equal(missing.state.ended, 1);
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const another = fakeDatabase();
    await assert.rejects(startCloudIngest({ config: configuration(occupied.address().port), openDatabase: async () => another.database,
      diagnosticLog: { async write() {} } }), { code: 'CLOUD_INGEST_START_FAILED' });
    assert.equal(another.state.ended, 1);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('connection diagnostics are admin-only, bounded metadata and never admit an unauthenticated device or write to storage', async t => {
  const lab = await start(t, { includeViewer: true, retrySweepSeconds: 3600 });
  const route = '/api/portal/device-connection-diagnostics';
  const anonymous = await fetch(lab.base + route, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(anonymous.status, 401); await anonymous.text();
  const admin = await login(lab);
  const headers = { Cookie: admin.cookie };
  const empty = await fetch(lab.base + route, { headers });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).state, 'no-recent-attempts');
  const callsBefore = lab.state.calls.length;
  const attempt = await fetch(lab.base + `/iclock/cdata?SN=TEST-DEVICE&pushver=2.4.1&pushcommkey=${token}&options=all`, {
    method: 'POST', headers: { Authorization: `Basic ${token}`, Cookie: `session=${privateText}` }, body: privateText });
  assert.equal(attempt.status, 401);
  assert.equal(await attempt.text(), 'UNAUTHENTICATED');
  const observed = await fetch(lab.base + route, { headers });
  assert.equal(observed.status, 200);
  assert.equal(observed.headers.get('cache-control'), 'no-store');
  const snapshot = await observed.json();
  assert.equal(snapshot.state, 'unauthenticated-attempt-observed');
  assert.equal(snapshot.authenticated, false);
  assert.equal(snapshot.sampled, true);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].recognizedDevice, true);
  assert.equal(snapshot.recent[0].authorizationKind, 'basic');
  assert.equal(snapshot.recent[0].cookiePresent, true);
  assert.equal(snapshot.recent[0].pushCommKeyPresent, true);
  assert.equal(snapshot.recent[0].protocolVersion, '2.4.1');
  assert.equal(lab.state.calls.length, callsBefore);
  assert.deepEqual(writes(lab.state), []);
  for (const value of [token, privateText, 'TEST-DEVICE']) assert.equal(JSON.stringify(snapshot).includes(value), false);
  const viewer = await login(lab, 'test-viewer');
  const forbidden = await fetch(lab.base + route, { headers: { Cookie: viewer.cookie } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, 'FORBIDDEN');
  const logout = await fetch(lab.base + '/auth/logout', { method: 'POST', headers: {
    ...headers, Origin: lab.base, 'X-CSRF-Token': admin.data.csrfToken } });
  assert.equal(logout.status, 200); await logout.text();
  const afterLogout = await fetch(lab.base + route, { headers });
  assert.equal(afterLogout.status, 401); await afterLogout.text();
});

test('Basic authentication stays disabled by default even when its header contains strong credentials and an allowed serial', async t => {
  const lab = await start(t, { retrySweepSeconds: 3600 });
  const callsBefore = lab.state.calls.length;
  const response = await fetch(lab.base + '/iclock/cdata?SN=TEST-DEVICE', {
    headers: { Authorization: basicAuthorization('fixture-native', 'N'.repeat(48)) } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  assert.equal(await response.text(), 'UNAUTHENTICATED');
  assert.equal(lab.state.calls.length, callsBefore);
  assert.deepEqual(writes(lab.state), []);
});

test('configured native Basic reaches the device allowlist, keeps Bearer working and does not grant portal access', async t => {
  const basicCredentials = { username: 'fixture-native', password: 'N'.repeat(48) };
  const machineHeader = { Authorization: basicAuthorization(basicCredentials.username, basicCredentials.password) };
  const lab = await start(t, { basicCredentials, retrySweepSeconds: 3600 });
  const unknown = await fetch(lab.base + '/iclock/cdata?SN=UNKNOWN', { headers: machineHeader });
  assert.equal(unknown.status, 403);
  assert.equal(await unknown.text(), 'DENIED');
  assert.deepEqual(writes(lab.state), []);
  const known = await fetch(lab.base + '/iclock/cdata?SN=TEST-DEVICE', { headers: machineHeader });
  assert.equal(known.status, 200);
  assert.match(await known.text(), /GET OPTION FROM: TEST-DEVICE/);
  assert.ok(writes(lab.state).some(call => call.sql.includes('biometric_svc_devices')));
  const bearer = await fetch(lab.base + '/iclock/getrequest?SN=TEST-DEVICE', {
    headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 200);
  assert.equal(await bearer.text(), 'OK');
  for (const route of ['/api/portal/overview', '/api/portal/received-punches', '/api/portal/device-connection-diagnostics']) {
    const response = await fetch(lab.base + route, { headers: machineHeader });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'UNAUTHENTICATED');
  }
  const rejectedPortalLogin = await fetch(lab.base + '/auth/login', { method: 'POST',
    headers: { Origin: lab.base, 'Content-Type': 'application/json' },
    body: JSON.stringify(basicCredentials) });
  assert.equal(rejectedPortalLogin.status, 401);
  await rejectedPortalLogin.text();
  const session = await login(lab);
  const overview = await fetch(lab.base + '/api/portal/overview', { headers: { Cookie: session.cookie } });
  assert.equal(overview.status, 200); await overview.text();
  const output = JSON.stringify(lab.logs);
  for (const value of [basicCredentials.username, basicCredentials.password, machineHeader.Authorization, token, 'TEST-DEVICE', 'UNKNOWN']) {
    assert.equal(output.includes(value), false);
  }
});

test('p:p and other rejected Basic attempts cannot observe the device or open an ATTLOG transaction', async t => {
  const basicCredentials = { username: 'fixture-native', password: 'N'.repeat(48) };
  const lab = await start(t, { basicCredentials, retrySweepSeconds: 3600 });
  const callsBefore = lab.state.calls.length;
  for (const method of ['GET', 'POST']) {
    for (const headers of [
      { Authorization: basicAuthorization('p', 'p') },
      { Authorization: basicAuthorization(basicCredentials.username, 'X'.repeat(48)) },
      { Cookie: `username=${basicCredentials.username}; password=${basicCredentials.password}` }
    ]) {
      const response = await fetch(lab.base + `/iclock/cdata?SN=TEST-DEVICE&table=ATTLOG&username=${basicCredentials.username}&password=${basicCredentials.password}`, {
        method, headers, ...(method === 'POST' ? { body: privateText } : {}) });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate'), /Basic realm="biometric-ingest"/);
      assert.equal(await response.text(), 'UNAUTHENTICATED');
    }
  }
  assert.equal(lab.state.calls.length, callsBefore);
  assert.deepEqual(writes(lab.state), []);
  const session = await login(lab);
  const response = await fetch(lab.base + '/api/portal/device-connection-diagnostics', { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 200);
  const diagnostics = await response.json();
  assert.equal(diagnostics.authenticated, false);
  assert.equal(diagnostics.recent.length, 6);
  const output = JSON.stringify({ diagnostics, logs: lab.logs });
  for (const value of [basicCredentials.username, basicCredentials.password, privateText,
    basicAuthorization('p', 'p'), 'TEST-DEVICE']) assert.equal(output.includes(value), false);
});

test('invalid Basic runtime configuration fails before the database factory is called', async () => {
  let databaseOpenCalls = 0;
  for (const basicCredentials of [
    'not-a-credential-object', [], {},
    { username: 'p', password: 'p' },
    { username: 'private-runtime-device' },
    { password: 'N'.repeat(48) },
    { username: 'private-runtime-device', password: undefined },
    { username: 'private-runtime-device', password: '' }
  ]) {
    await assert.rejects(startCloudIngest({ config: { ...configuration(0), basicCredentials },
      openDatabase: async () => { databaseOpenCalls++; throw new Error('The database must not be opened'); },
      diagnosticLog: { async write() {} } }), error => {
      assert.equal(error.code, 'CLOUD_INGEST_START_FAILED');
      assert.equal(error.cause, undefined);
      for (const value of ['private-runtime-device', 'N'.repeat(48)]) assert.equal(String(error.stack).includes(value), false);
      return true;
    });
  }
  assert.equal(databaseOpenCalls, 0);
});
