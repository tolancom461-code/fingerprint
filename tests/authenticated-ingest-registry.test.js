import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAuthenticatedRegistry } from '../src/infrastructure/ingest/authenticated-registry.js';
import { createHttpServer } from '../src/infrastructure/http/server.js';

const token = 'a'.repeat(64);

async function start(t) {
  const calls = [];
  const logs = [];
  const registry = createAuthenticatedRegistry({ token, diagnosticLog: { async write(entry) { logs.push(entry); } },
    registry: { match(req) { calls.push(['match', req.method]); return { async handle(req, res) {
      calls.push(['handle', req.method]); req.resume(); res.end('MACHINE_OK');
    } }; }, listVendors() { return ['zkteco']; } } });
  const server = createHttpServer({ adapterRegistry: registry, diagnosticLog: { async write(entry) { logs.push(entry); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { registry, calls, logs, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('machine authentication validates its own credential configuration', () => {
  for (const value of [null, '', 'a'.repeat(42), 'a'.repeat(129), 'a'.repeat(63) + '=', 123, 123n]) {
    assert.throws(() => createAuthenticatedRegistry({ token: value, registry: { match() {} } }), { code: 'INGEST_AUTH_CONFIG_INVALID' });
  }
});

test('GET and POST ADMS calls require the exact header before registry matching; query and cookie credentials never authenticate', async t => {
  const lab = await start(t);
  for (const method of ['GET', 'POST']) {
    for (const headers of [{}, { Cookie: `machine_token=${token}` }, { Authorization: `Bearer ${'b'.repeat(64)}` },
      { Authorization: `bearer ${token}` }, { Authorization: `Bearer  ${token}` }]) {
      const response = await fetch(`${lab.base}/iclock/cdata?SN=TEST&token=${token}`, {
        method, headers, ...(method === 'POST' ? { body: 'PRIVATE_UNAUTHENTICATED_PAYLOAD' } : {})
      });
      assert.equal(response.status, 401);
      assert.equal(await response.text(), 'UNAUTHENTICATED');
    }
  }
  assert.deepEqual(lab.calls, []);
  for (const method of ['GET', 'POST']) {
    const response = await fetch(lab.base + '/iclock/cdata?SN=TEST', { method, headers: { Authorization: `Bearer ${token}` },
      ...(method === 'POST' ? { body: 'synthetic' } : {}) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'MACHINE_OK');
  }
  assert.deepEqual(lab.calls, [['match', 'GET'], ['handle', 'GET'], ['match', 'POST'], ['handle', 'POST']]);
  assert.deepEqual(lab.registry.listVendors(), ['zkteco']);
  assert.equal(JSON.stringify(lab.logs).includes(token), false);
  assert.equal(JSON.stringify(lab.logs).includes('PRIVATE_UNAUTHENTICATED_PAYLOAD'), false);
});

test('duplicate Authorization headers are rejected even if one carries the correct credential', async t => {
  const lab = await start(t);
  const response = await new Promise((resolve, reject) => {
    const request = http.request(lab.base + '/iclock/getrequest?SN=TEST', {
      headers: { Authorization: [`Bearer ${token}`, `Bearer ${'b'.repeat(64)}`] }
    }, result => {
      let body = '';
      result.on('data', chunk => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode, body }));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(response.status, 401);
  assert.deepEqual(lab.calls, []);
});
