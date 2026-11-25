import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgramConnectionsService } from '../src/application/program-connections-service.js';
import { programConnectionsConfig } from '../src/config/program-connections.js';
import { createCloudIngestPortalHandler } from '../src/infrastructure/portal/server.js';
import { createSourcePunchesApiHandler } from '../src/infrastructure/integration/source-punches-api-server.js';
import { createAuthenticatedRegistry } from '../src/infrastructure/ingest/authenticated-registry.js';
import { createHttpServer } from '../src/infrastructure/http/server.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';

const password = 'Synthetic-program-portal-only!2026';
const passwordHash = await hashPassword(password);
const streamId = '1f999b36-e779-429b-b1d4-c6337d1e75c9';
async function start(t, enabled = true) {
  const state = { rows: [], sourceReads: 0, deviceWrites: 0, logs: [] };
  const service = new ProgramConnectionsService({ store: {
    async assertReady() { return { ready: true }; },
    async list() { return state.rows; },
    async create(input) {
      const row = { ...input, createdBy: input.actor, status: 'active', createdAtUtc: '2026-11-19T07:08:09.000000Z',
        revokedAtUtc: null, revokedBy: null };
      state.rows.push(row); return row;
    },
    async revoke({ id, actor }) {
      const row = state.rows.find(item => item.id === id);
      if (row?.status === 'active') Object.assign(row, { status: 'revoked', revokedBy: actor, revokedAtUtc: '2026-11-19T08:00:00.000000Z' });
      return row ?? null;
    },
    async findActiveByTokenHash(hash) { return state.rows.find(item => item.status === 'active' && item.tokenHash === hash) ?? null; },
  } });
  const noRead = async () => { throw new Error('No unrelated portal read is needed'); };
  const readStore = Object.fromEntries(['getDashboard', 'pageDevices', 'pagePeople', 'pageFinalEvents',
    'getIntakeCounts', 'pageReceivedPunches', 'pageDeviceUsers'].map(name => [name, noRead]));
  const source = enabled ? createSourcePunchesApiHandler({ connections: service, service: { async list() {
    state.sourceReads++; return { schemaVersion: 1, streamId, items: [], nextCursor: '0', hasMore: false };
  } } }) : null;
  const diagnosticLog = { async write(entry) { state.logs.push(entry); } };
  const registry = createAuthenticatedRegistry({ token: 'i'.repeat(64), diagnosticLog,
    registry: { match() { return { async handle(req, res) { state.deviceWrites++; req.resume(); res.end('ACK'); } }; } } });
  let portal;
  const server = createHttpServer({ adapterRegistry: registry, diagnosticLog,
    portalHandler: async (req, res) => (source && await source(req, res)) || portal(req, res) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  portal = createCloudIngestPortalHandler({ readStore, config: { origin: base, users: [
    { username: 'program-admin', passwordHash, role: 'admin' },
    { username: 'program-viewer', passwordHash, role: 'viewer' },
  ] }, programConnections: enabled ? { service, streamId } : null });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const login = async (username = 'program-admin') => {
    const response = await fetch(base + '/auth/login', { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], data: await response.json() };
  };
  const writes = (session, changes = {}) => ({ Cookie: session.cookie, Origin: base,
    'Content-Type': 'application/json', 'X-CSRF-Token': session.data.csrfToken, ...changes });
  return { base, state, login, writes };
}

test('program key configuration defaults off and rejects partial or ambiguous activation', () => {
  assert.equal(programConnectionsConfig({}), null);
  assert.equal(programConnectionsConfig({ BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'false' }), null);
  for (const config of [
    { BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'true' },
    { BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'yes', BIOMETRIC_INGEST_SOURCE_STREAM_ID: streamId },
  ]) assert.throws(() => programConnectionsConfig(config), { code: 'CLOUD_INGEST_CONFIG_INVALID' });
  assert.deepEqual(programConnectionsConfig({ BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'true',
    BIOMETRIC_INGEST_SOURCE_STREAM_ID: streamId }), { streamId });
});

test('only an administrator with the expected Origin and CSRF can create a program key', async t => {
  const lab = await start(t);
  assert.equal((await fetch(lab.base + '/api/portal/program-connections')).status, 401);
  const viewer = await lab.login('program-viewer');
  assert.equal(viewer.data.capabilities.programConnections, undefined);
  for (const method of ['GET', 'POST']) {
    const response = await fetch(lab.base + '/api/portal/program-connections', { method, headers: lab.writes(viewer),
      ...(method === 'POST' ? { body: JSON.stringify({ programName: 'Forged', role: 'admin' }) } : {}) });
    assert.equal(response.status, 403); await response.text();
  }
  const admin = await lab.login();
  assert.equal(admin.data.capabilities.programConnections, true);
  for (const changes of [{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'forged' }, { Origin: 'https://untrusted.example' }]) {
    const response = await fetch(lab.base + '/api/portal/program-connections', { method: 'POST',
      headers: lab.writes(admin, changes), body: JSON.stringify({ programName: 'TolanHR' }) });
    assert.equal(response.status, 403); await response.text();
  }
  const extra = await fetch(lab.base + '/api/portal/program-connections', { method: 'POST', headers: lab.writes(admin),
    body: JSON.stringify({ programName: 'TolanHR', scope: 'admin' }) });
  assert.equal(extra.status, 400); await extra.text();
  assert.equal(lab.state.rows.length, 0);
});

test('created key is shown once, authenticates reads only and is revoked immediately', async t => {
  const lab = await start(t);
  const admin = await lab.login();
  const createdResponse = await fetch(lab.base + '/api/portal/program-connections', { method: 'POST',
    headers: lab.writes(admin), body: JSON.stringify({ programName: 'TolanHR' }) });
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get('cache-control'), 'no-store');
  const created = await createdResponse.json();
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.streamId, streamId);
  assert.equal(created.connection.createdBy, 'program-admin');
  assert.equal(lab.state.rows[0].tokenHash.length, 64);
  assert.equal(JSON.stringify(lab.state.rows).includes(created.token), false);
  const list = await fetch(lab.base + '/api/portal/program-connections', { headers: { Cookie: admin.cookie } });
  assert.equal(list.status, 200);
  const listed = await list.text();
  assert.equal(listed.includes(created.token), false);
  assert.doesNotMatch(listed, /tokenHash|token_hash/);
  const bearer = { Authorization: `Bearer ${created.token}` };
  const source = await fetch(lab.base + '/api/v1/source-punches', { headers: bearer });
  assert.equal(source.status, 200); await source.text();
  const management = await fetch(lab.base + '/api/portal/program-connections', { headers: bearer });
  assert.equal(management.status, 401); await management.text();
  const ingest = await fetch(lab.base + '/iclock/cdata?SN=SYNTHETIC&table=ATTLOG', { method: 'POST', headers: bearer, body: 'SYNTHETIC' });
  assert.equal(ingest.status, 401); await ingest.text();
  assert.equal(lab.state.deviceWrites, 0);
  const revokePath = `/api/portal/program-connections/${created.connection.id}/revoke`;
  const unsafeRevoke = await fetch(lab.base + revokePath, { method: 'POST',
    headers: lab.writes(admin, { 'X-CSRF-Token': '' }), body: '{}' });
  assert.equal(unsafeRevoke.status, 403); await unsafeRevoke.text();
  const revoked = await fetch(lab.base + revokePath, { method: 'POST', headers: lab.writes(admin), body: '{}' });
  assert.equal(revoked.status, 200);
  const revokedText = await revoked.text();
  assert.equal(revokedText.includes(created.token), false);
  const denied = await fetch(lab.base + '/api/v1/source-punches', { headers: bearer });
  assert.equal(denied.status, 401); await denied.text();
  assert.equal(lab.state.sourceReads, 1);
  assert.equal(JSON.stringify(lab.state.logs).includes(created.token), false);
  assert.deepEqual(lab.state.logs, [{ type: 'machine_auth_rejected' }]);
});

test('disabled program feature exposes neither management capabilities nor program routes', async t => {
  const lab = await start(t, false);
  const admin = await lab.login();
  assert.equal(admin.data.capabilities.programConnections, undefined);
  const response = await fetch(lab.base + '/api/portal/program-connections', { headers: { Cookie: admin.cookie } });
  assert.equal(response.status, 404); await response.text();
  assert.equal((await fetch(lab.base + '/api/v1/source-punches')).status, 404);
  assert.equal((await fetch(lab.base + '/api/v1/device-identities')).status, 404);
  assert.equal(lab.state.rows.length, 0);
});
