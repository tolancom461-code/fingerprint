import { createHash } from 'node:crypto';

const DEFAULT_RETENTION_MS = 15 * 60 * 1000;
const MAX_RETENTION_MS = 60 * 60 * 1000;
const MAX_RECENT = 128;
const MAX_URL_LENGTH = 8192;
const MAX_ISO_TIME = 253402300799999;
const ROUTES = new Set(['cdata', 'getrequest', 'devicecmd', 'registry', 'exchange', 'push', 'fdata', 'ping']);
const SERIAL = /^[A-Za-z0-9._-]{1,128}$/;
const VERSION = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/;

// A diagnostic sample of rejected requests, never proof of device identity,
// successful ingestion, or online status. This module reads metadata only.
// Injected `now` supplies epoch milliseconds for TTL tests. Backward or invalid
// readings retain the last valid clock value; timestamps confer no identity proof.
export function createDeviceConnectionDiagnostics(options = {}) {
  const retentionMs = boundedInteger(read(options, 'retentionMs'), DEFAULT_RETENTION_MS, 1000, MAX_RETENTION_MS);
  const maxRecent = boundedInteger(read(options, 'maxRecent'), 32, 1, MAX_RECENT);
  const configuredNow = read(options, 'now');
  const now = typeof configuredNow === 'function' ? configuredNow : Date.now;
  const allowedHashes = permittedSerialHashes(read(options, 'allowedDevices'));
  let lastClockMs = 0;
  let recent = [];

  function clock() {
    let value;
    try { value = now(); } catch { return lastClockMs; }
    if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_ISO_TIME) {
      // A clock rollback must not manufacture future entries or reverse order.
      lastClockMs = Math.max(lastClockMs, value);
    }
    return lastClockMs;
  }

  function expire(at) {
    recent = recent.filter(entry => at - entry.at < retentionMs);
  }

  function recordRejectedRequest(req) {
    try {
      if (req === null || (typeof req !== 'object' && typeof req !== 'function')) return;
      const query = queryProjection(read(req, 'url'), allowedHashes);
      const header = headerProjection(req);
      const method = read(req, 'method');
      const at = clock();
      expire(at);
      recent.push({
        at,
        method: method === 'GET' || method === 'POST' ? method : 'OTHER',
        route: query.route,
        recognizedDevice: query.recognizedDevice,
        authorizationKind: header.authorizationKind,
        cookiePresent: header.cookiePresent,
        pushCommKeyPresent: header.pushCommKeyPresent || query.pushCommKeyPresent,
        protocolVersion: query.protocolVersion
      });
      if (recent.length > maxRecent) recent.shift();
    } catch { /* Diagnostics must never change the upstream rejection decision. */ }
  }

  function snapshot() {
    expire(clock());
    const sample = recent.slice().reverse().map(entry => ({
      occurredAtUtc: new Date(entry.at).toISOString(),
      method: entry.method,
      route: entry.route,
      recognizedDevice: entry.recognizedDevice,
      authorizationKind: entry.authorizationKind,
      cookiePresent: entry.cookiePresent,
      pushCommKeyPresent: entry.pushCommKeyPresent,
      protocolVersion: entry.protocolVersion
    }));
    return {
      windowMinutes: retentionMs / 60000,
      state: sample.length ? 'unauthenticated-attempt-observed' : 'no-recent-attempts',
      authenticated: false,
      sampled: true,
      countsDescribe: 'retained-sample-only',
      maxRecent,
      rejectedAttempts: sample.length,
      recognizedDeviceAttempts: sample.filter(entry => entry.recognizedDevice).length,
      recent: sample
    };
  }

  return Object.freeze({ recordRejectedRequest, snapshot });
}

function queryProjection(rawUrl, allowedHashes) {
  const clean = { route: 'other', recognizedDevice: false, pushCommKeyPresent: false, protocolVersion: null };
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_URL_LENGTH || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return clean;
  let url;
  try { url = new URL(rawUrl, 'http://diagnostic.invalid'); } catch { return clean; }
  const route = /^\/iclock\/([a-z]+)$/.exec(url.pathname)?.[1];
  if (ROUTES.has(route)) clean.route = route;
  let serial;
  let serialCount = 0;
  let version;
  let versionCount = 0;
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    if (name === 'sn') { serialCount++; serial = value; }
    else if (name === 'pushver') { versionCount++; version = value; }
    else if (name === 'pushcommkey') clean.pushCommKeyPresent = true;
  }
  if (serialCount === 1 && SERIAL.test(serial)) clean.recognizedDevice = allowedHashes.has(digest(serial));
  if (versionCount === 1 && typeof version === 'string' && version.length <= 11 && VERSION.test(version)) clean.protocolVersion = version;
  return clean;
}

function headerProjection(req) {
  const headers = read(req, 'headers');
  let authorization = readEither(headers, 'authorization', 'Authorization');
  let cookiePresent = present(readEither(headers, 'cookie', 'Cookie'));
  let pushCommKeyPresent = present(readEither(headers, 'pushcommkey', 'PushCommKey')) ||
    present(readEither(headers, 'push-comm-key', 'Push-Comm-Key'));
  let authorizationCount = 0;
  const raw = read(req, 'rawHeaders');
  if (isArray(raw)) {
    const length = read(raw, 'length');
    // Fixed scan budget, independent of attacker-controlled header count.
    const end = Number.isSafeInteger(length) ? Math.min(length, 512) : 0;
    for (let i = 0; i + 1 < end; i += 2) {
      const name = read(raw, i);
      if (typeof name !== 'string' || name.length > 64) continue;
      const lower = name.toLowerCase();
      if (lower === 'authorization') {
        authorizationCount++;
        if (!present(authorization)) authorization = read(raw, i + 1);
      } else if (lower === 'cookie') cookiePresent = true;
      else if (lower === 'pushcommkey' || lower === 'push-comm-key') pushCommKeyPresent = true;
    }
  }
  let authorizationKind = 'none';
  if (authorizationCount > 1 || isArray(authorization)) authorizationKind = 'multiple';
  else if (present(authorization)) {
    if (typeof authorization !== 'string' || authorization.length > 2048) authorizationKind = 'other';
    else if (/^\s*Bearer(?:\s|$)/i.test(authorization)) authorizationKind = 'bearer';
    else if (/^\s*Basic(?:\s|$)/i.test(authorization)) authorizationKind = 'basic';
    else authorizationKind = 'other';
  }
  return { authorizationKind, cookiePresent, pushCommKeyPresent };
}

function permittedSerialHashes(allowedDevices) {
  const hashes = new Set();
  if (!isArray(allowedDevices)) return hashes;
  const length = read(allowedDevices, 'length');
  const end = Number.isSafeInteger(length) ? Math.min(length, 100) : 0;
  for (let i = 0; i < end; i++) {
    const value = read(allowedDevices, i);
    if (typeof value === 'string' && value.length <= 135 && value.startsWith('zkteco:') && SERIAL.test(value.slice(7))) {
      hashes.add(digest(value.slice(7)));
    }
  }
  return hashes;
}

function digest(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function present(value) { return value !== undefined && value !== null; }
function read(object, key) { try { return object?.[key]; } catch { return undefined; } }
function readEither(object, lower, mixed) { const value = read(object, lower); return value === undefined ? read(object, mixed) : value; }
function isArray(value) { try { return Array.isArray(value); } catch { return false; } }
function boundedInteger(value, fallback, min, max) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}
