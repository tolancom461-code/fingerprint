import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 });
const HASH_PATTERN = /^scrypt-v1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PASSWORD_CHARACTERS = 256;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > MAX_PASSWORD_CHARACTERS || Buffer.byteLength(password) > 1024) {
    throw new Error('Password must contain between 12 and 256 characters and at most 1024 UTF-8 bytes');
  }
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt-v1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function validatePasswordHash(encoded) {
  return parsePasswordHash(encoded) !== null;
}

export function createPortalAuth({
  origin, users, now = Date.now, sessionTtlMs = 8 * 60 * 60 * 1000,
  maxAttempts = 5, windowMs = 15 * 60 * 1000,
  maxConcurrentLogins = 2, maxSessions = 1000, maxRateEntries = 4096
}) {
  const expectedOrigin = normalizeOrigin(origin);
  const secure = new URL(expectedOrigin).protocol === 'https:';
  const cookieName = secure ? '__Host-biometric_portal_session' : 'biometric_portal_session';
  positiveInteger(sessionTtlMs, 'sessionTtlMs', 7 * 24 * 60 * 60 * 1000);
  positiveInteger(maxAttempts, 'maxAttempts', 100);
  positiveInteger(windowMs, 'windowMs', 24 * 60 * 60 * 1000);
  positiveInteger(maxConcurrentLogins, 'maxConcurrentLogins', 16);
  positiveInteger(maxSessions, 'maxSessions', 10000);
  positiveInteger(maxRateEntries, 'maxRateEntries', 100000);
  if (maxRateEntries < 2) throw new Error('maxRateEntries must be at least 2');
  if (typeof now !== 'function') throw new Error('now must be a function');
  if (!Array.isArray(users) || users.length === 0) throw new Error('At least one configured portal user is required');

  const accounts = new Map();
  for (const account of users) {
    const username = cleanUsername(account?.username);
    const passwordHash = parsePasswordHash(account?.passwordHash);
    if (!username || !passwordHash || !['admin', 'viewer'].includes(account?.role)) {
      throw new Error('Each portal user requires a bounded username, valid scrypt-v1 passwordHash and admin or viewer role');
    }
    const lookup = username.toLowerCase();
    if (accounts.has(lookup)) throw new Error('Portal usernames must be unique ignoring case');
    accounts.set(lookup, { username, role: account.role, passwordHash });
  }

  const dummyHash = { salt: randomBytes(16), key: randomBytes(64) };
  const sessions = new Map();
  const rates = new Map();
  let activeLogins = 0;

  function assertOrigin(req) {
    if (header(req, 'origin') !== expectedOrigin) {
      throw authError('ORIGIN_REJECTED', 403, 'Request origin is not allowed');
    }
  }

  function current(req) {
    const id = sessionId(req, cookieName);
    if (!id) return null;
    const entry = sessions.get(id);
    if (!entry) return null;
    if (now() >= entry.expiresAtMs) {
      sessions.delete(id);
      return null;
    }
    return { id, entry };
  }

  function publicSession(entry) {
    return {
      user: { username: entry.username, role: entry.role },
      csrfToken: entry.csrfToken,
      expiresAt: new Date(entry.expiresAtMs).toISOString()
    };
  }

  function session(req) {
    const found = current(req);
    return found ? publicSession(found.entry) : null;
  }

  function requireWrite(req, suppliedSession) {
    assertOrigin(req);
    const found = current(req);
    if (!found || !suppliedSession || !equalText(suppliedSession.csrfToken, found.entry.csrfToken)) {
      throw authError('AUTH_REQUIRED', 401, 'Authentication is required');
    }
    if (!equalText(header(req, 'x-csrf-token'), found.entry.csrfToken)) {
      throw authError('CSRF_REJECTED', 403, 'Request verification failed');
    }
  }

  function consumeAttempt(req, username, time) {
    for (const [key, bucket] of rates) {
      if (time >= bucket.until) rates.delete(key);
    }
    // The address comes from the actual socket, never X-Forwarded-For.
    const address = String(req?.socket?.remoteAddress || 'unknown').slice(0, 128);
    const keys = [`ip:${address}`];
    if (username) keys.push(`account:${username.toLowerCase()}`);
    const buckets = keys.map(key => {
      let bucket = rates.get(key);
      if (bucket) {
        // Keep the actively used IP/account recent when bounding the map.
        rates.delete(key);
      } else {
        if (rates.size >= maxRateEntries) rates.delete(rates.keys().next().value);
        bucket = { count: 0, until: time + windowMs };
      }
      rates.set(key, bucket);
      return bucket;
    });
    if (buckets.some(bucket => bucket.count >= maxAttempts)) {
      throw authError('LOGIN_RATE_LIMITED', 429, 'Too many sign-in attempts; try again later');
    }
    for (const bucket of buckets) bucket.count++;
  }

  async function login(req, res, body) {
    assertOrigin(req);
    const username = cleanUsername(body?.username);
    const time = now();
    consumeAttempt(req, username, time);
    const password = body?.password;
    if (!username || typeof password !== 'string' || !password.length || password.length > MAX_PASSWORD_CHARACTERS || Buffer.byteLength(password) > 1024) {
      throw invalidCredentials();
    }
    if (activeLogins >= maxConcurrentLogins) {
      throw authError('LOGIN_BUSY', 429, 'Too many sign-in attempts; try again later');
    }
    const account = accounts.get(username.toLowerCase());
    const passwordHash = account?.passwordHash ?? dummyHash;
    let matches = false;
    activeLogins++;
    try {
      const candidate = await deriveKey(password, passwordHash.salt, 64, SCRYPT_OPTIONS);
      matches = timingSafeEqual(candidate, passwordHash.key);
    } catch {
      throw authError('AUTH_UNAVAILABLE', 503, 'Sign-in is temporarily unavailable');
    } finally {
      activeLogins--;
    }
    if (!account || !matches) throw invalidCredentials();

    const issuedAt = now();
    for (const [id, entry] of sessions) {
      if (issuedAt >= entry.expiresAtMs) sessions.delete(id);
    }
    const previous = sessionId(req, cookieName);
    if (previous) sessions.delete(previous);
    if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    const id = randomBytes(32).toString('base64url');
    const entry = {
      username: account.username, role: account.role,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAtMs: issuedAt + sessionTtlMs
    };
    sessions.set(id, entry);
    setCookie(res, serializeCookie(cookieName, id, secure, sessionTtlMs, entry.expiresAtMs));
    return publicSession(entry);
  }

  function logout(req, res) {
    const found = current(req);
    if (found) {
      requireWrite(req, publicSession(found.entry));
      sessions.delete(found.id);
    } else {
      assertOrigin(req);
    }
    setCookie(res, serializeCookie(cookieName, '', secure, 0, 0));
  }

  return Object.freeze({ login, session, logout, requireWrite, assertOrigin });
}

function invalidCredentials() {
  return authError('INVALID_CREDENTIALS', 401, 'Invalid username or password');
}

function authError(code, status, message) {
  return Object.assign(new Error(message), { code, status });
}

function parsePasswordHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const match = HASH_PATTERN.exec(encoded);
  if (!match) return null;
  const salt = Buffer.from(match[1], 'base64url');
  const key = Buffer.from(match[2], 'base64url');
  if (salt.length !== 16 || key.length !== 64 || salt.toString('base64url') !== match[1] || key.toString('base64url') !== match[2]) return null;
  return { salt, key };
}

function cleanUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim();
  if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username)) return null;
  return username;
}

function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A valid portal origin is required'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Portal origin must not include credentials, a path, query or fragment');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Portal origin must use HTTPS except on loopback HTTP');
  }
  return url.origin;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} is outside its supported range`);
}

function header(req, name) {
  const headers = req?.headers;
  if (!headers) return undefined;
  const key = Object.keys(headers).find(key => key.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function equalText(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length > 256) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionId(req, name) {
  const cookies = header(req, 'cookie');
  if (typeof cookies !== 'string' || cookies.length > 8192) return null;
  const values = cookies.split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const id = values[0].slice(name.length + 1);
  if (!TOKEN_PATTERN.test(id)) return null;
  const bytes = Buffer.from(id, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === id ? id : null;
}

function serializeCookie(name, value, secure, ttlMs, expiresAtMs) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${Math.ceil(ttlMs / 1000)}; Expires=${new Date(expiresAtMs).toUTCString()}`;
}

function setCookie(res, value) {
  const previous = res.getHeader?.('Set-Cookie');
  res.setHeader('Set-Cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), value] : value);
}
