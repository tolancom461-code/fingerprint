import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DeviceIdentitiesService } from '../src/application/device-identities-service.js';
import { ProgramConnectionsService } from '../src/application/program-connections-service.js';
import { createSourcePunchesApiHandler } from '../src/infrastructure/integration/source-punches-api-server.js';
import { createHttpServer } from '../src/infrastructure/http/server.js';

const token = 'd'.repeat(43);
const streamId = '1f999b36-e779-429b-b1d4-c6337d1e75c9';
async function start(t, enabled = true) {
  const state = { directoryReads: 0, punchReads: 0, authentications: 0, active: true, fail: false, logs: [] };
  const connections = new ProgramConnectionsService({ store: { async findActiveByTokenHash(hash) {
    state.authentications++; return state.active && hash === createHash('sha256').update(token).digest('hex')
      ? { id: streamId, programName: 'Synthetic consumer', status: 'active' } : null;
  }, async revoke() { state.active = false; return { id: streamId, status: 'revoked' }; } } });
  const directoryService = enabled ? new DeviceIdentitiesService({ streamId, readStore: { async listDeviceIdentitiesAfter() {
    state.directoryReads++;
    if (state.fail) throw new Error('PRIVATE-directory-SQL-' + token);
    return [{ id: '9007199254740993', device_id: '9007199254740994', device_user_id: '60001', display_name: 'اسم جهاز فقط',
      device_name: 'جهاز الاختبار', serial_number: 'SYNTHETIC-001', identity_status: 'historical',
      first_seen_at_utc: null, last_seen_at_utc: '2026-11-19 07:08:09.123456', identity_started_at_utc: null,
      identity_ended_at_utc: null, safe_metadata: { password: 'never-export' }, person_code: 'not-exported' }];
  } } }) : null;
  const handler = createSourcePunchesApiHandler({ connections, directoryService, service: { async list() {
    state.punchReads++; return { schemaVersion: 1, streamId, items: [], nextCursor: '0', hasMore: false };
  } } });
  const server = createHttpServer({ adapterRegistry: { match: () => null }, portalHandler: handler,
    diagnosticLog: { async write(entry) { state.logs.push(entry); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { state, connections, base: `http://127.0.0.1:${server.address().port}` };
}

test('directory uses the same per-program key, exposes safe nullable metadata and has no URL-key fallback', async t => {
  const lab = await start(t);
  for (const [query, headers] of [['', {}], [`?token=${token}`, {}], ['', { Cookie: 'biometric_portal_session=not-a-key' }],
    ['', { Authorization: 'Bearer ' + 'x'.repeat(43) }]]) {
    const response = await fetch(lab.base + '/api/v1/device-identities' + query, { headers });
    assert.equal(response.status, 401); await response.text();
  }
  assert.equal(lab.state.directoryReads, 0);
  const response = await fetch(lab.base + '/api/v1/device-identities', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const page = await response.json();
  assert.equal(page.streamId, streamId);
  assert.equal(page.items[0].identityId, '9007199254740993');
  assert.equal(page.items[0].displayName, 'اسم جهاز فقط');
  assert.equal(page.items[0].identityStartedAtUtc, null);
  assert.equal(page.items[0].status, 'historical');
  assert.doesNotMatch(JSON.stringify(page), /safe_metadata|password|person_code|never-export/);
});

test('directory rejects duplicate bearer headers, unsafe methods and unsupported/duplicate query parameters', async t => {
  const lab = await start(t);
  const headers = { Authorization: `Bearer ${token}` };
  const duplicate = await new Promise((resolve, reject) => {
    const request = http.request(lab.base + '/api/v1/device-identities', { headers: ['Host', new URL(lab.base).host,
      'Authorization', `Bearer ${token}`, 'Authorization', `Bearer ${token}`] }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(duplicate, 401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await fetch(lab.base + '/api/v1/device-identities', { method, headers });
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET'); await response.text();
  }
  for (const query of ['?limit=501', '?after_id=-1', '?limit=1&limit=2', '?after_id=0&after_id=1', '?search=anything', '?token=forbidden']) {
    const response = await fetch(lab.base + '/api/v1/device-identities' + query, { headers });
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal(lab.state.directoryReads, 0);
});

test('revocation blocks directory on the next request and directory failure does not disable punch reads', async t => {
  const lab = await start(t);
  const headers = { Authorization: `Bearer ${token}` };
  lab.state.fail = true;
  const failed = await fetch(lab.base + '/api/v1/device-identities', { headers });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'DIRECTORY_API_UNAVAILABLE' });
  const punches = await fetch(lab.base + '/api/v1/source-punches', { headers });
  assert.equal(punches.status, 200); await punches.text();
  await lab.connections.revoke({ id: streamId, actor: 'fixture-admin' });
  const revoked = await fetch(lab.base + '/api/v1/device-identities', { headers });
  assert.equal(revoked.status, 401); await revoked.text();
  assert.equal(lab.state.directoryReads, 1);
  assert.equal(lab.state.punchReads, 1);
  assert.deepEqual(lab.state.logs, []);
});

test('missing versioned identity schema returns authenticated 503 while the existing punch API still works', async t => {
  const lab = await start(t, false);
  assert.equal((await fetch(lab.base + '/api/v1/device-identities')).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  const missing = await fetch(lab.base + '/api/v1/device-identities', { headers });
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: 'DIRECTORY_API_UNAVAILABLE' });
  const punches = await fetch(lab.base + '/api/v1/source-punches', { headers });
  assert.equal(punches.status, 200); await punches.text();
  assert.equal(lab.state.directoryReads, 0);
  assert.equal(lab.state.punchReads, 1);
});
