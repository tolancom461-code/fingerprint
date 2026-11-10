import { createHash, timingSafeEqual } from 'node:crypto';
import { discardWithoutCapture, text } from '../http/http-utils.js';
import { normalizeBasicMachineCredentials } from './basic-machine-credentials.js';

const MACHINE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_BASIC_HEADER_LENGTH = 6 + 4 * Math.ceil((32 + 1 + 128) / 3);

// Only configured machine credentials in Authorization authenticate ADMS.
// Portal sessions, URL/query credentials and serial numbers are never fallbacks.
export function createAuthenticatedRegistry({ registry, token, diagnosticLog, rejectedRequestObserver = null,
  basicCredentials = null }) {
  if (!registry || typeof registry.match !== 'function' || typeof token !== 'string' || !MACHINE_TOKEN.test(token) ||
      (rejectedRequestObserver !== null && typeof rejectedRequestObserver !== 'function')) {
    throw Object.assign(new Error('Invalid machine ingest authentication configuration'), { code: 'INGEST_AUTH_CONFIG_INVALID' });
  }
  const expected = digest(token);
  const basic = normalizeBasicMachineCredentials(basicCredentials);
  const expectedBasic = basic ? digest(`${basic.username}:${basic.password}`) : null;
  const authenticatedAdapter = Object.freeze({
    async handle(req, res) {
      const authorization = req.headers?.authorization;
      const duplicateHeaders = Array.isArray(req.rawHeaders)
        ? req.rawHeaders.filter((name, index) => index % 2 === 0 && String(name).toLowerCase() === 'authorization').length > 1
        : false;
      const candidate = typeof authorization === 'string' ? /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization)?.[1] : null;
      let authenticated = false;
      if (!duplicateHeaders) {
        if (candidate) authenticated = timingSafeEqual(expected, digest(candidate));
        else if (expectedBasic) {
          const candidateBasic = basicCredentialDigest(authorization);
          authenticated = candidateBasic !== null && timingSafeEqual(expectedBasic, candidateBasic);
        }
      }
      if (!authenticated) {
        discardWithoutCapture(req);
        res.setHeader('Connection', 'close');
        res.setHeader('WWW-Authenticate', expectedBasic
          ? ['Bearer', 'Basic realm="biometric-ingest", charset="UTF-8"'] : 'Bearer');
        // The synchronous observer only classifies the rejected request. Its
        // failure cannot admit a request or reach the device adapter/storage.
        try { rejectedRequestObserver?.(req); } catch {}
        try { await diagnosticLog?.write({ type: 'machine_auth_rejected' }); } catch {}
        text(res, 401, 'UNAUTHENTICATED');
        return;
      }
      const adapter = registry.match(req);
      if (!adapter) {
        discardWithoutCapture(req);
        text(res, 404, 'NOT_FOUND');
        return;
      }
      await adapter.handle(req, res);
    }
  });
  return Object.freeze({
    match(req) {
      const url = new URL(req.url || '/', 'http://biometric.local');
      return url.pathname.startsWith('/iclock/') ? authenticatedAdapter : null;
    },
    listVendors() { return typeof registry.listVendors === 'function' ? registry.listVendors() : []; }
  });
}

function digest(value) { return createHash('sha256').update(value, 'utf8').digest(); }

function basicCredentialDigest(header) {
  if (typeof header !== 'string' || header.length > MAX_BASIC_HEADER_LENGTH) return null;
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header)?.[1];
  if (!encoded || encoded.length % 4 !== 0) return null;
  const decoded = Buffer.from(encoded, 'base64');
  // Buffer's decoder is permissive. Require canonical standard Base64 and exact
  // printable ASCII credentials before comparing constant-length SHA-256 values.
  if (decoded.length < 34 || decoded.length > 161 || decoded.toString('base64') !== encoded ||
      decoded.some(byte => byte < 0x21 || byte > 0x7e)) return null;
  const plaintext = decoded.toString('ascii');
  const delimiter = plaintext.indexOf(':');
  if (delimiter <= 0) return null;
  try {
    const credentials = normalizeBasicMachineCredentials({
      username: plaintext.slice(0, delimiter), password: plaintext.slice(delimiter + 1)
    });
    return digest(`${credentials.username}:${credentials.password}`);
  } catch { return null; }
}
