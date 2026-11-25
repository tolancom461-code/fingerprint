import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startCloudIngest } from '../src/infrastructure/ingest/cloud-runtime.js';
import { ProgramConnectionsService } from '../src/application/program-connections-service.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';

const token = 'd'.repeat(43);
const passwordHash = await hashPassword('Synthetic-directory-runtime!2026');
const streamId = '1f999b36-e779-429b-b1d4-c6337d1e75c9';
async function start(t, { enabled = true, identity = true } = {}) {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const state = { calls: [], logs: [], closed: false, authentications: 0 };
  // Credential storage/verification is exercised through the real service in
  // the API suites. These mocks isolate runtime construction and schema gating.
  t.mock.method(ProgramConnectionsService.prototype, 'assertReady', async () => ({ ready: true }));
  t.mock.method(ProgramConnectionsService.prototype, 'authenticate', async value => {
    state.authentications++; return value === token ? { scope: 'punches-and-directory:read' } : null;
  });
  const database = {
    async checkReady() { return { ready: true, ...(identity ? { deviceUserIdentityEnabled: true } : {}) }; },
    async execute(sql, params = []) {
      state.calls.push({ sql, params });
      if (sql.includes('DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT')) return [[
        { DATA_TYPE: 'tinyint', COLUMN_TYPE: 'tinyint unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
      ], []];
      if (sql.includes('FROM `biometric_svc_device_users` u')) return [[{ id: '9007199254740993',
        device_id: '9007199254740994', device_user_id: '60001', display_name: 'اسم اختبار', device_name: 'جهاز اختبار',
        serial_number: 'SYNTHETIC', identity_status: 'current', first_seen_at_utc: null, last_seen_at_utc: null,
        identity_started_at_utc: null, identity_ended_at_utc: null }], []];
      if (sql.trimStart().startsWith('SELECT')) return [[], []];
      throw new Error('Unexpected runtime fixture write');
    },
    async getConnection() { throw new Error('No real ingest operation belongs in this fixture'); },
    async end() { state.closed = true; },
  };
  const base = `http://127.0.0.1:${port}`;
  const config = { host: '127.0.0.1', port, token: 'i'.repeat(64), allowedDevices: ['zkteco:SYNTHETIC'],
    portal: { origin: base, users: [{ username: 'fixture-admin', passwordHash, role: 'admin' }] },
    database: { synthetic: true }, maxBodyBytes: 1024, autoFinalizeNewPunches: false,
    retrySweepSeconds: 60, retryDelaySeconds: 1, replayLimit: 1000,
    adms: { delaySeconds: 10, errorDelaySeconds: 60, realtime: 1, encrypt: 0 },
    ...(enabled ? { programConnections: { streamId } } : {}) };
  const runtime = await startCloudIngest({ config, openDatabase: async settings => {
    assert.equal(settings.programConnectionsEnabled === true, enabled); return database;
  }, diagnosticLog: { async write(entry) { state.logs.push(entry); } } });
  t.after(async () => { await runtime.close(); assert.equal(state.closed, true); });
  return { base, state };
}

test('runtime mounts directory reads only with program opt-in and versioned identity readiness', async t => {
  for (const identity of [false, true]) await t.test(identity ? 'versioned identities' : 'legacy identity schema', async context => {
    const lab = await start(context, { identity });
    const response = await fetch(lab.base + '/api/v1/device-identities', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, identity ? 200 : 503);
    const data = await response.json();
    if (identity) {
      assert.equal(data.streamId, streamId);
      assert.equal(data.items[0].identityId, '9007199254740993');
      assert.equal(data.items[0].identityStartedAtUtc, null);
    } else assert.deepEqual(data, { error: 'DIRECTORY_API_UNAVAILABLE' });
    const punches = await fetch(lab.base + '/api/v1/source-punches', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(punches.status, 200); await punches.text();
    assert.equal(lab.state.calls.some(call => call.sql.includes('FROM `biometric_svc_device_users` u')), identity);
    assert.equal(lab.state.calls.every(call => call.sql.trimStart().startsWith('SELECT')), true);
    assert.equal(JSON.stringify(lab.state.logs).includes(token), false);
  });
});

test('runtime feature remains off by default for both program read endpoints', async t => {
  const lab = await start(t, { enabled: false });
  for (const route of ['/api/v1/device-identities', '/api/v1/source-punches']) {
    const response = await fetch(lab.base + route, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 404); await response.text();
  }
  assert.equal(lab.state.authentications, 0);
  assert.equal(lab.state.calls.some(call => call.sql.includes('FROM `biometric_svc_device_users` u')), false);
});
