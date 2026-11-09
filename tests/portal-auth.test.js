import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalAuth, hashPassword, validatePasswordHash } from '../src/infrastructure/portal/auth.js';

const origin = 'https://biometric.example.test';
const password = 'Portal-test-password-2026';
const passwordHash = await hashPassword(password);
const users = [
  { username: 'Administrator', passwordHash, role: 'admin' },
  { username: 'Reader', passwordHash, role: 'viewer' }
];

function request({ cookie, csrfToken, ip = '127.0.0.7', requestOrigin = origin, forwarded } = {}) {
  return {
    socket: { remoteAddress: ip },
    headers: {
      ...(requestOrigin !== undefined ? { origin: requestOrigin } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(forwarded ? { 'x-forwarded-for': forwarded } : {})
    }
  };
}

function response() {
  const headers = new Map();
  return { getHeader: name => headers.get(name), setHeader: (name, value) => headers.set(name, value), headers };
}

function cookieFrom(res) {
  const value = res.headers.get('Set-Cookie');
  return (Array.isArray(value) ? value.at(-1) : value).split(';')[0];
}

async function signIn(auth, options = {}) {
  const req = request(options);
  const res = response();
  const session = await auth.login(req, res, { username: options.username ?? 'Administrator', password, role: options.role });
  return { session, cookie: cookieFrom(res), res };
}

test('password hashes have fixed scrypt parameters and independent random salts', async () => {
  const another = await hashPassword(password);
  assert.notEqual(another, passwordHash);
  const [version, salt, key] = another.split('$');
  assert.equal(version, 'scrypt-v1');
  assert.equal(Buffer.from(salt, 'base64url').length, 16);
  assert.equal(Buffer.from(key, 'base64url').length, 64);
  assert.equal(validatePasswordHash(another), true);
  for (const value of [null, '', 'plain-password', another.replace('scrypt-v1', 'scrypt-v2'), another + '=', another + '$extra', 'scrypt-v1$short$short']) {
    assert.equal(validatePasswordHash(value), false);
  }
  await assert.rejects(hashPassword('short'), /between 12 and 256/);
  await assert.rejects(hashPassword('a'.repeat(257)), /between 12 and 256/);
});

test('configuration requires explicit users and HTTPS except for loopback HTTP', () => {
  assert.throws(() => createPortalAuth({ origin, users: [] }), /At least one/);
  assert.throws(() => createPortalAuth({ origin, users: [{ username: 'admin', password: 'plaintext', role: 'admin' }] }), /passwordHash/);
  assert.throws(() => createPortalAuth({ origin, users: [{ ...users[0], role: 'owner' }] }), /admin or viewer/);
  assert.throws(() => createPortalAuth({ origin, users: [users[0], { ...users[0], username: 'administrator' }] }), /unique/);
  for (const badOrigin of ['http://public.example', 'ftp://localhost', 'https://user:secret@example.test', origin + '/path']) {
    assert.throws(() => createPortalAuth({ origin: badOrigin, users }), /origin|HTTPS/);
  }
  for (const local of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
    assert.doesNotThrow(() => createPortalAuth({ origin: local, users }));
  }
});

test('HTTPS login issues an opaque secure host cookie and exposes only configured identity', async () => {
  const auth = createPortalAuth({ origin, users });
  const signed = await signIn(auth, { username: 'administrator', role: 'viewer' });
  const setCookie = signed.res.headers.get('Set-Cookie');
  assert.match(setCookie, /^__Host-biometric_portal_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Secure/);
  assert.doesNotMatch(setCookie, /Domain=/i);
  assert.deepEqual(signed.session.user, { username: 'Administrator', role: 'admin' });
  assert.deepEqual(Object.keys(signed.session).sort(), ['csrfToken', 'expiresAt', 'user']);
  assert.match(signed.session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(auth.session(request({ cookie: signed.cookie })), signed.session);
  signed.session.user.role = 'viewer';
  assert.equal(auth.session(request({ cookie: signed.cookie })).user.role, 'admin');
});

test('loopback HTTP uses a distinct HttpOnly Strict cookie without the Secure attribute', async () => {
  const local = 'http://127.0.0.1:8080';
  const auth = createPortalAuth({ origin: local, users });
  const signed = await signIn(auth, { requestOrigin: local });
  const value = signed.res.headers.get('Set-Cookie');
  assert.match(value, /^biometric_portal_session=/);
  assert.match(value, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(value, /; Secure/);
});

test('unknown usernames and wrong passwords return the same generic failure without cookies', async () => {
  const auth = createPortalAuth({ origin, users });
  for (const body of [
    { username: 'Administrator', password: 'wrong-password-value' },
    { username: 'missing-account', password },
    { username: 'Administrator', password: 'a'.repeat(257) },
    { username: 'Administrator', password: { secret: password } }
  ]) {
    const res = response();
    await assert.rejects(auth.login(request(), res, body), { code: 'INVALID_CREDENTIALS', status: 401, message: 'Invalid username or password' });
    assert.equal(res.headers.has('Set-Cookie'), false);
  }
});

test('successful login rotates the current cookie session and expires the previous ID', async () => {
  const auth = createPortalAuth({ origin, users });
  const before = await signIn(auth);
  const after = await signIn(auth, { cookie: before.cookie });
  assert.notEqual(before.cookie, after.cookie);
  assert.notEqual(before.session.csrfToken, after.session.csrfToken);
  assert.equal(auth.session(request({ cookie: before.cookie })), null);
  assert.equal(auth.session(request({ cookie: after.cookie })).user.role, 'admin');
  assert.equal(auth.session(request({ cookie: after.cookie + '; ' + after.cookie })), null);
});

test('server-side expiry invalidates the session even if its cookie is retained', async () => {
  let time = 0;
  const auth = createPortalAuth({ origin, users, now: () => time, sessionTtlMs: 1000 });
  const signed = await signIn(auth);
  time = 999;
  assert.ok(auth.session(request({ cookie: signed.cookie })));
  time = 1000;
  assert.equal(auth.session(request({ cookie: signed.cookie })), null);
});

test('write validation requires exact origin, live session and matching CSRF for either role', async () => {
  const auth = createPortalAuth({ origin, users });
  const signed = await signIn(auth, { username: 'Reader', role: 'admin' });
  assert.equal(signed.session.user.role, 'viewer');
  const valid = { cookie: signed.cookie, csrfToken: signed.session.csrfToken };
  assert.doesNotThrow(() => auth.requireWrite(request(valid), signed.session));
  assert.throws(() => auth.requireWrite(request({ ...valid, requestOrigin: origin + '.evil' }), signed.session), { code: 'ORIGIN_REJECTED', status: 403 });
  assert.throws(() => auth.requireWrite(request({ cookie: signed.cookie }), signed.session), { code: 'CSRF_REJECTED', status: 403 });
  assert.throws(() => auth.requireWrite(request({ ...valid, csrfToken: 'forged' }), signed.session), { code: 'CSRF_REJECTED', status: 403 });
  assert.throws(() => auth.requireWrite(request({ csrfToken: signed.session.csrfToken }), signed.session), { code: 'AUTH_REQUIRED', status: 401 });
  assert.throws(() => auth.requireWrite(request(valid), { ...signed.session, csrfToken: 'forged' }), { code: 'AUTH_REQUIRED', status: 401 });
});

test('login origin is enforced before authentication and missing origin is rejected', async () => {
  const auth = createPortalAuth({ origin, users });
  const req = request();
  delete req.headers.origin;
  await assert.rejects(auth.login(req, response(), { username: 'Administrator', password }), { code: 'ORIGIN_REJECTED', status: 403 });
  await assert.rejects(auth.login(request({ requestOrigin: origin + '/' }), response(), { username: 'Administrator', password }), { code: 'ORIGIN_REJECTED', status: 403 });
});

test('viewer logout invalidates the session and expires the cookie only after CSRF validation', async () => {
  const auth = createPortalAuth({ origin, users });
  const signed = await signIn(auth, { username: 'Reader' });
  assert.throws(() => auth.logout(request({ cookie: signed.cookie }), response()), { code: 'CSRF_REJECTED' });
  assert.ok(auth.session(request({ cookie: signed.cookie })));
  const res = response();
  auth.logout(request({ cookie: signed.cookie, csrfToken: signed.session.csrfToken }), res);
  assert.equal(auth.session(request({ cookie: signed.cookie })), null);
  assert.match(res.headers.get('Set-Cookie'), /^__Host-biometric_portal_session=;/);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.match(res.headers.get('Set-Cookie'), /Expires=Thu, 01 Jan 1970/);
});

test('socket-IP throttling cannot be bypassed by rotating forwarded addresses or usernames', async () => {
  let time = 0;
  const auth = createPortalAuth({ origin, users, now: () => time, maxAttempts: 2, windowMs: 1000, maxRateEntries: 2 });
  for (const [index, username] of ['missing-one', 'missing-two'].entries()) {
    await assert.rejects(auth.login(request({ forwarded: `198.51.100.${index}` }), response(), { username, password }), { code: 'INVALID_CREDENTIALS' });
  }
  await assert.rejects(auth.login(request({ forwarded: '203.0.113.200' }), response(), { username: 'Administrator', password }), { code: 'LOGIN_RATE_LIMITED', status: 429 });
  time = 1000;
  assert.equal((await signIn(auth)).session.user.role, 'admin');
});

test('account throttling also applies across socket IP addresses and username case variations', async () => {
  const auth = createPortalAuth({ origin, users, maxAttempts: 2 });
  for (const [index, username] of ['Administrator', 'administrator'].entries()) {
    await assert.rejects(auth.login(request({ ip: `192.0.2.${index}` }), response(), { username, password: 'wrong-password-value' }), { code: 'INVALID_CREDENTIALS' });
  }
  await assert.rejects(auth.login(request({ ip: '192.0.2.3' }), response(), { username: 'ADMINISTRATOR', password }), { code: 'LOGIN_RATE_LIMITED', status: 429 });
});

test('scrypt concurrency is bounded without queueing additional expensive work', async () => {
  const auth = createPortalAuth({ origin, users, maxConcurrentLogins: 1 });
  const pending = auth.login(request(), response(), { username: 'Administrator', password });
  await assert.rejects(auth.login(request({ ip: '192.0.2.2' }), response(), { username: 'Reader', password }), { code: 'LOGIN_BUSY', status: 429 });
  assert.equal((await pending).user.role, 'admin');
});

test('bounded session storage evicts an older session instead of growing without limit', async () => {
  const auth = createPortalAuth({ origin, users, maxSessions: 1 });
  const first = await signIn(auth);
  const second = await signIn(auth, { username: 'Reader' });
  assert.equal(auth.session(request({ cookie: first.cookie })), null);
  assert.equal(auth.session(request({ cookie: second.cookie })).user.role, 'viewer');
});
