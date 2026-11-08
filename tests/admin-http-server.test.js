import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminServer } from '../src/infrastructure/admin/server.js';

async function withServer(adminService, fn) {
  const server = createAdminServer({ adminService, diagnosticLog: { async write() {} } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try { return await fn(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('local admin serves the bilingual standalone UI with Arabic default and security headers', async () => {
  await withServer({ async overview() { return {}; } }, async (base) => {
    const response = await fetch(`${base}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(html, /إدارة البصمة/);
    assert.match(html, /يحتاج ربط/);
    assert.match(html, /id="languageButton"/);
    assert.match(html, />English<\/button>/);
    assert.doesNotMatch(html, /source_punch_id|person_id/);
  });
});

test('overview endpoint returns only the admin read model supplied by the service', async () => {
  await withServer({ async overview() { return { dashboard: { openIssues: 0 } }; } }, async (base) => {
    const response = await fetch(`${base}/api/overview`);
    assert.deepEqual(await response.json(), { dashboard: { openIssues: 0 } });
  });
});

test('write endpoints require JSON plus the local UI header', async () => {
  let calls = 0;
  await withServer({ async createPerson() { calls += 1; return { id: 1 }; } }, async (base) => {
    const rejected = await fetch(`${base}/api/people`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(rejected.status, 400);
    assert.equal(calls, 0);

    const accepted = await fetch(`${base}/api/people`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-biometric-admin': 'local-ui' },
      body: JSON.stringify({ personCode: '175', displayName: 'Ahmed' })
    });
    assert.equal(accepted.status, 201);
    assert.equal(calls, 1);
  });
});

test('filtered admin read endpoints map query parameters to the standalone read service', async () => {
  const seen = [];
  const adminService = {
    async listEvents(filters) { seen.push(['events', filters]); return { items: [], page: { total: 0 } }; },
    async listPeople(filters) { seen.push(['people', filters]); return { items: [], page: { total: 0 } }; },
    async listIssues(filters) { seen.push(['issues', filters]); return { items: [], page: { total: 0 } }; },
    async listDevices(filters) { seen.push(['devices', filters]); return { items: [], page: { total: 0 } }; },
    async listUnmappedDeviceUsers(filters) { seen.push(['unmapped', filters]); return { items: [], page: { total: 0 } }; },
    async operationalReports(filters) { seen.push(['reports', filters]); return { systemHealth: {} }; }
  };
  await withServer(adminService, async (base) => {
    assert.equal((await fetch(`${base}/api/events?page=2&event_type=check_in&device_id=1&from=2026-09-01`)).status, 200);
    assert.equal((await fetch(`${base}/api/people?mapping=mapped&search=900`)).status, 200);
    assert.equal((await fetch(`${base}/api/issues?status=resolved&issue_type=invalid_time`)).status, 200);
    assert.equal((await fetch(`${base}/api/devices?mode=test&vendor=zkteco`)).status, 200);
    assert.equal((await fetch(`${base}/api/unmapped-device-users?device_id=1`)).status, 200);
    assert.equal((await fetch(`${base}/api/reports/operational?from=2026-09-01&to=2026-09-03`)).status, 200);
  });
  assert.equal(seen[0][1].eventType, 'check_in');
  assert.equal(seen[0][1].deviceId, '1');
  assert.equal(seen[1][1].mapping, 'mapped');
  assert.equal(seen[2][1].issueType, 'invalid_time');
  assert.equal(seen[3][1].vendor, 'zkteco');
  assert.equal(seen[5][1].to, '2026-09-03');
});

test('event detail endpoint exposes a safe final-event model and clean not-found response', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  await withServer({ async getEvent(id) { return id === uuid ? { final_event_uuid: id, person_code: '900003' } : null; } }, async (base) => {
    const found = await fetch(`${base}/api/events/${uuid}`);
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), { event: { final_event_uuid: uuid, person_code: '900003' } });
    const missing = await fetch(`${base}/api/events/22222222-2222-4222-8222-222222222222`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'EVENT_NOT_FOUND', message: 'Final event not found' });
  });
});

test('event CSV export is Excel-compatible, formula-safe, and excludes internal biometric IDs', async () => {
  await withServer({
    async exportEvents() {
      return [{
        final_event_uuid: '11111111-1111-4111-8111-111111111111', person_code: '=900003', person_name: '+Test',
        event_type: 'check_in', event_time_local: '2026-09-02 13:47:52', event_timezone: 'Asia/Riyadh',
        event_time_utc: '2026-09-02 10:47:52', device_display_name: 'SpeedFace-V5L', verification_method: 'fingerprint', status: 'final'
      }];
    }
  }, async (base) => {
    const response = await fetch(`${base}/api/events/export.csv?lang=en`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), /biometric-final-events/);
    assert.match(body, /Event ID/);
    assert.match(body, /'=900003/);
    assert.match(body, /'\+Test/);
    assert.doesNotMatch(body, /person_id|source_punch_id|worker_id/);
  });
});

test('historical preview is read-only and manual historical reprocessing requires the local UI write guard', async () => {
  let reprocessCalls = 0;
  const adminService = {
    async previewHistoricalEvents(input) {
      assert.deepEqual(input, { personId: 30001, from: '2026-09-01', to: '2026-09-02' });
      return { person: { personCode: '900002' }, count: 2 };
    },
    async reprocessHistoricalEvents(input) {
      reprocessCalls += 1;
      assert.deepEqual(input, { personId: 30001, from: '2026-09-01', to: '2026-09-02', confirmed: true });
      return { reissuedCount: 2 };
    }
  };
  await withServer(adminService, async (base) => {
    const preview = await fetch(`${base}/api/people/30001/historical-events/preview?from=2026-09-01&to=2026-09-02`);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).count, 2);

    const rejected = await fetch(`${base}/api/people/30001/historical-events/reprocess`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: '2026-09-01', to: '2026-09-02', confirmed: true })
    });
    assert.equal(rejected.status, 400);
    assert.equal(reprocessCalls, 0);

    const accepted = await fetch(`${base}/api/people/30001/historical-events/reprocess`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-biometric-admin': 'local-ui' },
      body: JSON.stringify({ from: '2026-09-01', to: '2026-09-02', confirmed: true })
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { reissuedCount: 2 });
    assert.equal(reprocessCalls, 1);
  });
});
