import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAuthenticatedRegistry } from '../src/infrastructure/ingest/authenticated-registry.js';
import { createHttpServer } from '../src/infrastructure/http/server.js';

const token = 'a'.repeat(64);
const machineBasic = Object.freeze({ username: 'synthetic-device', password: 'aZ_9'.repeat(12) });
const basicHeader = (username = machineBasic.username, password = machineBasic.password, scheme = 'Basic') =>
  `${scheme} ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

async function start(t, rejectedRequestObserver = null, basicCredentials = null) {
  const calls = [];
  const logs = [];
  const registry = createAuthenticatedRegistry({ token, rejectedRequestObserver, basicCredentials,
    diagnosticLog: { async write(entry) { logs.push(entry); } },
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

test('rejection observers see rejected attempts only and cannot change the authentication decision', async t => {
  let observed = 0;
  const lab = await start(t, () => { observed++; throw new Error('PRIVATE_DIAGNOSTIC_FAILURE' + token); });
  const rejected = await fetch(lab.base + '/iclock/cdata?SN=TEST', { method: 'POST', body: 'PRIVATE_BODY' });
  assert.equal(rejected.status, 401);
  assert.equal(await rejected.text(), 'UNAUTHENTICATED');
  assert.equal(observed, 1);
  assert.deepEqual(lab.calls, []);
  const accepted = await fetch(lab.base + '/iclock/getrequest?SN=TEST', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), 'MACHINE_OK');
  assert.equal(observed, 1);
  assert.equal(JSON.stringify(lab.logs).includes('PRIVATE_DIAGNOSTIC_FAILURE'), false);
  assert.throws(() => createAuthenticatedRegistry({ token, registry: { match() {} }, rejectedRequestObserver: {} }),
    { code: 'INGEST_AUTH_CONFIG_INVALID' });
});

test('Basic remains disabled by default even with otherwise valid machine credentials', async t => {
  let observed = 0;
  const lab = await start(t, () => { observed++; });
  for (const method of ['GET', 'POST']) {
    const response = await fetch(lab.base + '/iclock/cdata?SN=TEST', { method,
      headers: { Authorization: basicHeader() }, ...(method === 'POST' ? { body: 'SYNTHETIC_PRIVATE_BASIC_BODY' } : {}) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal(await response.text(), 'UNAUTHENTICATED');
  }
  assert.equal(observed, 2);
  assert.deepEqual(lab.calls, []);
});

test('opt-in Basic accepts exact machine credentials for GET and POST while preserving Bearer and the vendor registry boundary', async t => {
  let observed = 0;
  const input = { ...machineBasic };
  const lab = await start(t, () => { observed++; }, input);
  input.username = 'changed-after-start'; input.password = 'b'.repeat(32);
  for (const method of ['GET', 'POST']) {
    for (const scheme of ['Basic', 'basic', 'bAsIc']) {
      const response = await fetch(lab.base + '/iclock/cdata?SN=TEST', { method,
        headers: { Authorization: basicHeader(undefined, undefined, scheme) },
        ...(method === 'POST' ? { body: 'SYNTHETIC_PRIVATE_BASIC_BODY' } : {}) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'MACHINE_OK');
    }
  }
  const bearer = await fetch(lab.base + '/iclock/getrequest?SN=TEST', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 200);
  assert.equal(await bearer.text(), 'MACHINE_OK');
  assert.equal(lab.calls.filter(call => call[0] === 'match').length, 7);
  assert.equal(lab.calls.filter(call => call[0] === 'handle').length, 7);
  assert.equal(observed, 0);
  assert.doesNotMatch(JSON.stringify(lab.logs), /synthetic-device|SYNTHETIC_PRIVATE_BASIC_BODY/);
});

test('wrong Basic credentials, probe credentials, query values and cookies never fall through to the adapter', async t => {
  const lab = await start(t, null, machineBasic);
  const fakeQuery = `?SN=TEST&username=${machineBasic.username}&password=${machineBasic.password}&token=${token}`;
  const attempts = [{}, { Cookie: `username=${machineBasic.username}; password=${machineBasic.password}; machine_token=${token}` },
    { Authorization: basicHeader('p', 'p') }, { Authorization: basicHeader(machineBasic.username.toUpperCase()) },
    { Authorization: basicHeader(undefined, machineBasic.password.toLowerCase()) },
    { Authorization: basicHeader('changed-after-start', 'b'.repeat(32)) }, { Authorization: `bearer ${token}` }];
  for (const headers of attempts) {
    const response = await fetch(lab.base + '/iclock/cdata' + fakeQuery, {
      method: 'POST', headers, body: 'SYNTHETIC_PRIVATE_BASIC_BODY' });
    assert.equal(response.status, 401);
    const challenge = response.headers.get('www-authenticate');
    assert.match(challenge, /Bearer/);
    assert.match(challenge, /Basic realm="biometric-ingest", charset="UTF-8"/);
    assert.equal(challenge.includes(machineBasic.username), false);
    assert.equal(challenge.includes(machineBasic.password), false);
    assert.equal(await response.text(), 'UNAUTHENTICATED');
  }
  assert.deepEqual(lab.calls, []);
  const logs = JSON.stringify(lab.logs);
  for (const secret of [token, machineBasic.username, machineBasic.password, basicHeader(), 'SYNTHETIC_PRIVATE_BASIC_BODY']) {
    assert.equal(logs.includes(secret), false);
  }
});

test('Basic parsing rejects noncanonical Base64, invalid framing, control characters, Unicode and excessive credential size', async t => {
  const lab = await start(t, null, machineBasic);
  const encoded = basicHeader().slice(6);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = encoded.endsWith('==') ? 2 : 1;
  const position = encoded.length - padding - 1;
  const changedPaddingBits = encoded.slice(0, position) + alphabet[alphabet.indexOf(encoded[position]) + 1] + encoded.slice(position + 1);
  assert.deepEqual(Buffer.from(changedPaddingBits, 'base64'), Buffer.from(encoded, 'base64'));
  const headers = [
    'Basic', `Basic  ${encoded}`, `Basic\t${encoded}`, `Basic ${encoded.slice(0, -1)}`,
    `Basic ${encoded}=`, `Basic ${encoded}ABCD`, `Basic ${changedPaddingBits}`, 'Basic ab-c',
    basicHeader(undefined, machineBasic.password + '\u0000'), basicHeader(undefined, machineBasic.password + '\r\n'),
    basicHeader('dévice'), basicHeader(undefined, machineBasic.password + 'é'),
    basicHeader('user:extra'), basicHeader(undefined, machineBasic.password + ':extra'),
    basicHeader('x'.repeat(50), 'a'.repeat(160))
  ];
  for (const authorization of headers) {
    const response = await fetch(lab.base + '/iclock/cdata?SN=TEST', { method: 'POST',
      headers: { Authorization: authorization }, body: 'SYNTHETIC_PRIVATE_BASIC_BODY' });
    assert.equal(response.status, 401);
    assert.equal(await response.text(), 'UNAUTHENTICATED');
  }
  assert.deepEqual(lab.calls, []);
});

test('duplicate Authorization fields deny Basic even when both credentials would be independently valid', async t => {
  let observed = 0;
  const lab = await start(t, () => { observed++; }, machineBasic);
  for (const values of [[basicHeader(), basicHeader()], [basicHeader(), `Bearer ${token}`]]) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(lab.base + '/iclock/getrequest?SN=TEST', { headers: { Authorization: values } }, result => {
        let body = '';
        result.on('data', chunk => { body += chunk; });
        result.on('end', () => resolve({ status: result.statusCode, body }));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(response.status, 401);
    assert.equal(response.body, 'UNAUTHENTICATED');
  }
  assert.equal(observed, 2);
  assert.deepEqual(lab.calls, []);
});

test('credentials inside an absolute request URL do not replace the Authorization header', async t => {
  const lab = await start(t, null, machineBasic);
  const base = new URL(lab.base);
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: base.hostname, port: base.port,
      path: `https://${machineBasic.username}:${machineBasic.password}@diagnostic.invalid/iclock/cdata?SN=TEST` }, result => {
      let body = '';
      result.on('data', chunk => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode, body }));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(response.status, 401);
  assert.equal(response.body, 'UNAUTHENTICATED');
  assert.deepEqual(lab.calls, []);
  assert.equal(JSON.stringify(lab.logs).includes(machineBasic.password), false);
});

test('optional Basic configuration fails closed before any request for weak or incomplete credentials', () => {
  for (const basicCredentials of [{}, { username: 'p', password: 'p' }, { username: 'device' },
    { password: machineBasic.password }, { username: undefined, password: undefined }]) {
    assert.throws(() => createAuthenticatedRegistry({ token, registry: { match() {} }, basicCredentials }),
      { code: 'INGEST_AUTH_CONFIG_INVALID' });
  }
});
