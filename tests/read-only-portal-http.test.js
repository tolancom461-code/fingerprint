import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyPortalHandler } from '../src/infrastructure/portal/server.js';
import { createHttpServer } from '../src/infrastructure/http/server.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';

const password = 'Local-read-model-test!2026';
const passwordHash = await hashPassword(password);
const eventUuid = '48d47491-e7bf-4af5-b617-f361f193f5c4';

async function start(t) {
  const calls = [];
  let unavailable = false;
  const page = { number: 1, limit: 10, total: 1, totalPages: 1 };
  const readStore = {
    async getDashboard() {
      calls.push('dashboard');
      if (unavailable) throw new Error('internal database connection details must stay private');
      return { devices: { total: 12 }, people: { total: 43 }, finalEvents: { total: 280 } };
    },
    async pageDevices(filters) {
      calls.push(['devices', filters]);
      return { items: [{ id: '9007199254740993', serial_number: 'TEST-SERIAL', display_name: 'جهاز الاختبار',
        model: 'Test model', status: 'active', last_seen_at: '2026-11-09 07:00:00', last_ip_address: 'private-value' }], page };
    },
    async pagePeople(filters) {
      calls.push(['people', filters]);
      return { items: [{ id: '9007199254740994', person_code: 'TEST-100', display_name: 'شخص اختبار', status: 'active', notes: 'private-note' }], page };
    },
    async pageFinalEvents(filters) {
      calls.push(['events', filters]);
      return { items: [{ final_event_uuid: eventUuid, person_code: 'TEST-100', person_name: 'شخص اختبار',
        event_type: 'break_out', event_time_utc: '2026-11-09 07:15:00', verification_method: 'card',
        device_display_name: 'جهاز الاختبار', internal_field: 'private-value' }], page };
    },
    async createPerson() { calls.push('WRITE'); throw new Error('writes must never be invoked'); }
  };
  let handler;
  const server = createHttpServer({ adapterRegistry: { match: () => null }, diagnosticLog: { async write() {} },
    portalHandler: (...args) => handler(...args) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createReadOnlyPortalHandler({ config: { origin: base, users: [
    { username: 'test-admin', passwordHash, role: 'admin' },
    { username: 'test-viewer', passwordHash, role: 'viewer' }
  ] }, readStore });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base, calls, failSource() { unavailable = true; }, async login(username = 'test-admin') {
    const response = await fetch(base + '/auth/login', { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200);
    return { data: await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
  } };
}

test('read-only source stays behind authentication and advertises the correct document mode', async t => {
  const lab = await start(t);
  for (const route of ['overview', 'devices', 'people', 'events']) {
    const response = await fetch(`${lab.base}/api/portal/${route}`);
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.deepEqual(lab.calls, []);
  const login = await fetch(lab.base + '/login');
  assert.match(await login.text(), /data-portal-mode="database-readonly"/);
  const session = await lab.login();
  assert.equal(session.data.mode, 'database-readonly');
  assert.deepEqual(session.data.capabilities, { createPerson: false });
  const root = await fetch(lab.base + '/', { headers: { Cookie: session.cookie } });
  assert.match(await root.text(), /data-portal-mode="database-readonly"/);
  const current = await fetch(lab.base + '/auth/session', { headers: { Cookie: session.cookie } });
  assert.equal((await current.json()).capabilities.createPerson, false);
});

test('authenticated routes project stored records without demo rows, private columns or invented connection status', async t => {
  const lab = await start(t);
  const session = await lab.login();
  const headers = { Cookie: session.cookie };
  const overview = await (await fetch(lab.base + '/api/portal/overview', { headers })).json();
  assert.deepEqual(overview.counts, { devices: 12, people: 43, events: 280 });
  assert.equal(overview.deviceConnection, 'unknown');
  const devices = await (await fetch(lab.base + '/api/portal/devices?limit=10', { headers })).json();
  assert.equal(devices.items[0].id, '9007199254740993');
  assert.equal(devices.items[0].status, 'unknown');
  assert.equal(devices.items[0].administrativeStatus, 'active');
  assert.equal(devices.items[0].lastSeenAt, '2026-11-09T07:00:00Z');
  const people = await (await fetch(lab.base + '/api/portal/people?search=TEST-100&limit=10', { headers })).json();
  assert.equal(people.items[0].personCode, 'TEST-100');
  const events = await (await fetch(lab.base + '/api/portal/events?limit=10', { headers })).json();
  assert.equal(events.items[0].id, eventUuid);
  assert.equal(events.items[0].eventTimeUtc, '2026-11-09T07:15:00Z');
  assert.doesNotMatch(JSON.stringify({ overview, devices, people, events }), /private-value|private-note|internal_field|DEMO-/);
  const peopleRead = lab.calls.find(call => Array.isArray(call) && call[0] === 'people');
  assert.equal(peopleRead[1].search, 'TEST-100');
});

test('read-only admin and viewer cannot create people even with valid credentials, Origin and CSRF', async t => {
  const lab = await start(t);
  for (const username of ['test-admin', 'test-viewer']) {
    const session = await lab.login(username);
    const headers = { Cookie: session.cookie, Origin: lab.base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.data.csrfToken };
    const response = await fetch(lab.base + '/api/portal/people', { method: 'POST', headers,
      body: JSON.stringify({ personCode: 'TEST-FORGED', displayName: 'اختبار', role: 'admin' }) });
    assert.equal(response.status, 403);
    if (username === 'test-admin') assert.equal((await response.json()).error, 'READ_ONLY');
    else await response.text();
    const logout = await fetch(lab.base + '/auth/logout', { method: 'POST', headers, body: '{}' });
    assert.equal(logout.status, 200);
    await logout.text();
  }
  assert.equal(lab.calls.includes('WRITE'), false);
  assert.deepEqual(lab.calls, []);
});

test('source failure returns an error without SQL details or silent demo substitution', async t => {
  const lab = await start(t);
  const session = await lab.login();
  lab.failSource();
  const response = await fetch(lab.base + '/api/portal/overview', { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR', message: 'تعذر إتمام الطلب' });
});
