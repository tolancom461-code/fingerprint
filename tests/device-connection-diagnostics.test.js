import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceConnectionDiagnostics } from '../src/infrastructure/ingest/device-connection-diagnostics.js';

const allowedDevices = ['zkteco:SYNTHETIC-DEVICE'];
function request(url = '/iclock/cdata?SN=SYNTHETIC-DEVICE&pushver=2.4.1', extra = {}) {
  return { method: 'GET', url, headers: {}, rawHeaders: [], ...extra };
}

test('empty snapshot is explicitly unauthenticated and describes bounded sample counts', () => {
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => 1000 });
  assert.deepEqual(diagnostics.snapshot(), {
    windowMinutes: 15, state: 'no-recent-attempts', authenticated: false,
    sampled: true, countsDescribe: 'retained-sample-only', maxRecent: 32,
    rejectedAttempts: 0, recognizedDeviceAttempts: 0, recent: []
  });
});

test('classifies only fixed request metadata and stores no request secrets or body', () => {
  const serial = 'PRIVATE-SERIAL';
  const secret = 'PRIVATE_TOKEN_COOKIE_KEY_PAYLOAD';
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices: ['zkteco:' + serial], now: () => 1000 });
  const req = request(`/iclock/cdata?SN=${serial}&pushver=2.4.1&unknown=${secret}`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + secret, cookie: secret, pushcommkey: secret, 'x-sensitive': secret },
    rawHeaders: ['Authorization', 'Bearer ' + secret, 'Cookie', secret, 'PushCommKey', secret],
    socket: { remoteAddress: '192.0.2.255', privateProperty: secret }
  });
  Object.defineProperty(req, 'body', { get() { throw new Error('Request body must never be accessed'); } });
  diagnostics.recordRejectedRequest(req);
  req.url = '/' + secret;
  req.headers.authorization = 'Basic ' + secret;
  const result = diagnostics.snapshot();
  assert.equal(result.state, 'unauthenticated-attempt-observed');
  assert.equal(result.authenticated, false);
  assert.equal(result.rejectedAttempts, 1);
  assert.equal(result.recognizedDeviceAttempts, 1);
  assert.deepEqual(result.recent[0], {
    occurredAtUtc: '1970-01-01T00:00:01.000Z', method: 'POST', route: 'cdata',
    recognizedDevice: true, authorizationKind: 'bearer', cookiePresent: true,
    pushCommKeyPresent: true, protocolVersion: '2.4.1'
  });
  const serialized = JSON.stringify(result);
  for (const prohibited of [serial, secret, '192.0.2.255', '"authorization":', 'rawHeaders', 'socket', 'body']) {
    assert.equal(serialized.includes(prohibited), false, prohibited);
  }
});

test('serial matching is exact and duplicate case-insensitive SN parameters are not recognized', () => {
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => 1000 });
  for (const serial of ['synthetic-device', 'SYNTHETIC-DEVICE-X', 'SYNTHETIC-DEVICE%00']) {
    diagnostics.recordRejectedRequest(request('/iclock/cdata?SN=' + serial));
  }
  diagnostics.recordRejectedRequest(request('/iclock/cdata?SN=SYNTHETIC-DEVICE&sn=SYNTHETIC-DEVICE'));
  diagnostics.recordRejectedRequest(request('/iclock/cdata?sN=SYNTHETIC-DEVICE'));
  assert.equal(diagnostics.snapshot().recognizedDeviceAttempts, 1);
  assert.deepEqual(diagnostics.snapshot().recent.map(entry => entry.recognizedDevice), [true, false, false, false, false]);
});

test('only tiny single pushver values survive; arbitrary query data and PushVersion do not', () => {
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => 1000 });
  for (const suffix of ['pushver=2.4.1', 'pushver=3.1.6S-SECRET', 'pushver=2.4.1&pushver=9.9.9',
    'PushVersion=2.4.1', 'pushver=9999.2.3', 'pushver=01.2.3', 'pushver=2.4.1%0ASECRET']) {
    diagnostics.recordRejectedRequest(request('/iclock/cdata?SN=SYNTHETIC-DEVICE&' + suffix));
  }
  assert.deepEqual(diagnostics.snapshot().recent.map(entry => entry.protocolVersion), [null, null, null, null, null, null, '2.4.1']);
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes('SECRET'), false);
});

test('route and method classifications do not persist unrecognized path or method text', () => {
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => 1000 });
  for (const route of ['cdata', 'getrequest', 'devicecmd', 'registry', 'exchange', 'push', 'fdata', 'ping']) {
    diagnostics.recordRejectedRequest(request('/iclock/' + route, { method: 'POST' }));
  }
  diagnostics.recordRejectedRequest(request('/iclock/PRIVATE-PATH', { method: 'PRIVATE-METHOD' }));
  diagnostics.recordRejectedRequest(request('/iclock/%63data', { method: 'get' }));
  const result = diagnostics.snapshot();
  assert.deepEqual(result.recent.map(entry => entry.route), ['other', 'other', 'ping', 'fdata', 'push', 'exchange', 'registry', 'devicecmd', 'getrequest', 'cdata']);
  assert.equal(result.recent[0].method, 'OTHER');
  assert.equal(result.recent[1].method, 'OTHER');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('recognizes authorization kinds and duplicate raw authorization headers without keeping values', () => {
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => 1000 });
  const candidates = [
    {},
    { authorization: 'Bearer PRIVATE' },
    { authorization: 'Basic PRIVATE' },
    { authorization: 'Digest PRIVATE' },
    { authorization: ['Bearer PRIVATE', 'Basic PRIVATE'] }
  ];
  for (const headers of candidates) diagnostics.recordRejectedRequest(request(undefined, { headers }));
  diagnostics.recordRejectedRequest(request(undefined, { rawHeaders: ['AUTHORIZATION', 'Bearer PRIVATE', 'Authorization', 'Bearer PRIVATE'] }));
  diagnostics.recordRejectedRequest(request(undefined, { rawHeaders: ['Authorization', 'Basic PRIVATE', 'Cookie', '', 'Push-Comm-Key', 'PRIVATE'] }));
  const result = diagnostics.snapshot();
  assert.deepEqual(result.recent.map(entry => entry.authorizationKind), ['basic', 'multiple', 'multiple', 'other', 'basic', 'bearer', 'none']);
  assert.equal(result.recent[0].cookiePresent, true);
  assert.equal(result.recent[0].pushCommKeyPresent, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('records only the presence of a PushCommKey query value', () => {
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => 1000 });
  diagnostics.recordRejectedRequest(request('/iclock/cdata?PushCommKey=PRIVATE-KEY&pushver=2.4.1'));
  assert.equal(diagnostics.snapshot().recent[0].pushCommKeyPresent, true);
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes('PRIVATE-KEY'), false);
});

test('classifying native exchange requests does not read key material or prove authentication', () => {
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => 1000 });
  const req = request('/iclock/exchange?SN=SYNTHETIC-DEVICE&type=publickey&publickey=PRIVATE-KEY-MATERIAL');
  let bodyReads = 0;
  Object.defineProperty(req, 'body', { get() { bodyReads++; throw new Error('Body must not be read'); } });
  diagnostics.recordRejectedRequest(req);
  const result = diagnostics.snapshot();
  assert.equal(result.recent[0].route, 'exchange');
  assert.equal(result.recent[0].recognizedDevice, true);
  assert.equal(result.authenticated, false);
  assert.equal(bodyReads, 0);
  assert.equal(JSON.stringify(result).includes('PRIVATE-KEY-MATERIAL'), false);
  assert.equal(JSON.stringify(result).includes('publickey'), false);
});

test('retention expires entries at the boundary and counters describe the surviving sample', () => {
  let at = 1000;
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => at, retentionMs: 1000 });
  diagnostics.recordRejectedRequest(request());
  at = 1500;
  diagnostics.recordRejectedRequest(request('/iclock/cdata?SN=OTHER'));
  at = 1999;
  assert.equal(diagnostics.snapshot().rejectedAttempts, 2);
  at = 2000;
  assert.equal(diagnostics.snapshot().rejectedAttempts, 1);
  assert.equal(diagnostics.snapshot().recognizedDeviceAttempts, 0);
  at = 2500;
  assert.equal(diagnostics.snapshot().state, 'no-recent-attempts');
});

test('ring bounds retained memory and does not present sample counts as a complete request count', () => {
  let at = 1000;
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => at, maxRecent: 3 });
  for (let i = 0; i < 10000; i++) {
    at++;
    diagnostics.recordRejectedRequest(request(i < 9997 ? undefined : '/iclock/cdata?SN=OTHER'));
  }
  const result = diagnostics.snapshot();
  assert.equal(result.recent.length, 3);
  assert.equal(result.rejectedAttempts, 3);
  assert.equal(result.recognizedDeviceAttempts, 0);
  assert.equal(result.sampled, true);
  assert.equal(result.countsDescribe, 'retained-sample-only');
  assert.equal(result.maxRecent, 3);
  assert.deepEqual(result.recent.map(entry => entry.occurredAtUtc), [11000, 10999, 10998].map(value => new Date(value).toISOString()));
});

test('clock rollback is clamped, invalid clocks do not throw, and no state escapes via snapshots', () => {
  let at = 2000;
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => {
    if (at === 'throw') throw new Error('PRIVATE-CLOCK');
    return at;
  }, retentionMs: 1000 });
  diagnostics.recordRejectedRequest(request());
  at = 1000;
  diagnostics.recordRejectedRequest(request());
  at = 'throw';
  assert.doesNotThrow(() => diagnostics.snapshot());
  at = Infinity;
  diagnostics.recordRejectedRequest(request());
  const result = diagnostics.snapshot();
  assert.equal(result.recent.length, 3);
  assert.ok(result.recent.every(entry => entry.occurredAtUtc === '1970-01-01T00:00:02.000Z'));
  result.recent[0].route = 'PRIVATE-MUTATION';
  result.recent.length = 0;
  result.authenticated = true;
  assert.equal(diagnostics.snapshot().recent.length, 3);
  assert.equal(diagnostics.snapshot().authenticated, false);
  assert.equal(diagnostics.snapshot().recent[0].route, 'cdata');
  at = 3000;
  assert.equal(diagnostics.snapshot().rejectedAttempts, 0);
});

test('hostile metadata, proxies, oversized URLs and raw header getters cannot access body or leak values', () => {
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices, now: () => 1000 });
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  const hostile = new Proxy({}, { get() { throw new Error('PRIVATE-GETTER'); } });
  const rawHeaders = ['Authorization', 'Bearer PRIVATE'];
  Object.defineProperty(rawHeaders, 0, { get() { throw new Error('PRIVATE-HEADER'); } });
  for (const candidate of [undefined, null, 1, 'PRIVATE', hostile,
    request('/' + 'PRIVATE'.repeat(3000)),
    request('https://PRIVATE.example/iclock/cdata?SN=SYNTHETIC-DEVICE'),
    request('//PRIVATE.example/iclock/cdata?SN=SYNTHETIC-DEVICE'),
    request(undefined, { headers: hostile, rawHeaders }),
    request(undefined, { headers: revoked.proxy, rawHeaders: revoked.proxy })]) {
    assert.doesNotThrow(() => diagnostics.recordRejectedRequest(candidate));
  }
  const result = diagnostics.snapshot();
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.ok(result.recent.every(entry => ['none', 'bearer', 'basic', 'other', 'multiple'].includes(entry.authorizationKind)));
});

test('configuration caps retained sample, retention and allowed identities independently of input size', () => {
  const devices = Array.from({ length: 10000 }, (_, index) => 'zkteco:DEVICE-' + index);
  const diagnostics = createDeviceConnectionDiagnostics({ allowedDevices: devices, now: () => 1000, retentionMs: 1e12, maxRecent: 1e12 });
  diagnostics.recordRejectedRequest(request('/iclock/cdata?SN=DEVICE-99'));
  diagnostics.recordRejectedRequest(request('/iclock/cdata?SN=DEVICE-100'));
  assert.equal(diagnostics.snapshot().recognizedDeviceAttempts, 1);
  for (let i = 0; i < 200; i++) diagnostics.recordRejectedRequest(request());
  assert.equal(diagnostics.snapshot().windowMinutes, 60);
  assert.equal(diagnostics.snapshot().maxRecent, 128);
  assert.equal(diagnostics.snapshot().recent.length, 128);
  const minimum = createDeviceConnectionDiagnostics({ now: () => 1000, retentionMs: 0, maxRecent: 0 });
  assert.equal(minimum.snapshot().windowMinutes, 1 / 60);
  assert.equal(minimum.snapshot().maxRecent, 1);
  const defaults = createDeviceConnectionDiagnostics({ allowedDevices: revokedArray(), now: () => NaN, retentionMs: NaN, maxRecent: 'PRIVATE' });
  assert.equal(defaults.snapshot().windowMinutes, 15);
  assert.equal(defaults.snapshot().maxRecent, 32);
});

function revokedArray() {
  const revocable = Proxy.revocable([], {});
  revocable.revoke();
  return revocable.proxy;
}
