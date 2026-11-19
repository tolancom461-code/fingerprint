import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SourcePunchesService } from '../src/application/source-punches-service.js';
import { createSourcePunchesApiHandler } from '../src/infrastructure/integration/source-punches-api-server.js';
import { createHttpServer } from '../src/infrastructure/http/server.js';

const token = 'r'.repeat(43);
const streamId = '1f999b36-e779-429b-b1d4-c6337d1e75c9';
async function start(t) {
  const state = { reads: 0, authentications: 0, active: true, fail: false, logs: [] };
  const service = new SourcePunchesService({ streamId, readStore: { async listSourcePunchesAfter() {
    state.reads++;
    if (state.fail) throw new Error('PRIVATE-SQL-DETAILS-' + token);
    return [{ id: '9007199254740993', event_key: 'a'.repeat(64), device_id: '9007199254740994',
      device_user_id: '60001', device_user_row_id: null, punch_state: 'break_out', raw_status: '2',
      device_event_time_utc: '2026-11-19 07:08:09.123456' }];
  } } });
  const handler = createSourcePunchesApiHandler({ service, connections: { async authenticate(value) {
    state.authentications++; return state.active && value === token ? { scope: 'punches:read' } : null;
  } } });
  const server = createHttpServer({ adapterRegistry: { match: () => null },
    diagnosticLog: { async write(entry) { state.logs.push(entry); } }, portalHandler: handler });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { state, base: `http://127.0.0.1:${server.address().port}` };
}

test('source read requires its bearer key and rejects query, cookie and duplicate authorization credentials', async t => {
  const lab = await start(t);
  for (const [query, headers] of [
    ['', {}], ['', { Cookie: 'biometric_portal_session=not-a-key' }],
    [`?token=${token}`, {}], ['', { Authorization: 'Basic ' + token }],
    ['', { Authorization: 'Bearer ' + 'x'.repeat(43) }],
  ]) {
    const response = await fetch(lab.base + '/api/v1/source-punches' + query, { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(await response.json(), { error: 'AUTH_REQUIRED' });
  }
  const duplicate = await new Promise((resolve, reject) => {
    const request = http.request(lab.base + '/api/v1/source-punches', {
      headers: ['Host', new URL(lab.base).host, 'Authorization', `Bearer ${token}`, 'Authorization', `Bearer ${token}`],
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end();
  });
  assert.equal(duplicate, 401);
  assert.equal(lab.state.reads, 0);
  assert.deepEqual(lab.state.logs, []);
});

test('authorized source response is bounded, stable and not cached or exposed through CORS', async t => {
  const lab = await start(t);
  const response = await fetch(lab.base + '/api/v1/source-punches?after_id=0&limit=1', {
    headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const page = await response.json();
  assert.equal(page.schemaVersion, 1);
  assert.equal(page.streamId, streamId);
  assert.equal(page.nextCursor, '9007199254740993');
  assert.equal(page.items[0].sourceIdentityId, null);
  assert.equal(page.items[0].eventTimeUtc, '2026-11-19T07:08:09.123456Z');
  assert.equal(lab.state.reads, 1);
});

test('source endpoint denies unsafe methods and malformed pagination without a storage read', async t => {
  const lab = await start(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await fetch(lab.base + '/api/v1/source-punches', { method,
      headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET');
    await response.text();
  }
  for (const query of ['?limit=0', '?limit=501', '?after_id=-1', '?after_id=18446744073709551616',
    '?limit=1&limit=2', '?after_id=0&after_id=1', '?token=not-accepted']) {
    const response = await fetch(lab.base + '/api/v1/source-punches' + query, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' });
  }
  assert.equal(lab.state.reads, 0);
});

test('source revocation takes effect on the next request and failures do not disclose tokens or SQL in logs', async t => {
  const lab = await start(t);
  const headers = { Authorization: `Bearer ${token}` };
  lab.state.fail = true;
  const failed = await fetch(lab.base + '/api/v1/source-punches', { headers });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'SOURCE_API_UNAVAILABLE' });
  lab.state.fail = false;
  lab.state.active = false;
  const revoked = await fetch(lab.base + '/api/v1/source-punches', { headers });
  assert.equal(revoked.status, 401);
  await revoked.text();
  assert.equal(lab.state.reads, 1);
  assert.equal(lab.state.authentications, 2);
  assert.deepEqual(lab.state.logs, []);
});
