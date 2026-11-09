import { createHash, timingSafeEqual } from 'node:crypto';
import { discardWithoutCapture, text } from '../http/http-utils.js';

const MACHINE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

// Only this machine credential authenticates ADMS requests. A portal session,
// query parameter or device serial number cannot substitute for the header.
export function createAuthenticatedRegistry({ registry, token, diagnosticLog }) {
  if (!registry || typeof registry.match !== 'function' || typeof token !== 'string' || !MACHINE_TOKEN.test(token)) {
    throw Object.assign(new Error('Invalid machine ingest authentication configuration'), { code: 'INGEST_AUTH_CONFIG_INVALID' });
  }
  const expected = digest(token);
  const authenticatedAdapter = Object.freeze({
    async handle(req, res) {
      const authorization = req.headers?.authorization;
      const duplicateHeaders = Array.isArray(req.rawHeaders)
        ? req.rawHeaders.filter((name, index) => index % 2 === 0 && String(name).toLowerCase() === 'authorization').length > 1
        : false;
      const candidate = typeof authorization === 'string' ? /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization)?.[1] : null;
      if (duplicateHeaders || !candidate || !timingSafeEqual(expected, digest(candidate))) {
        discardWithoutCapture(req);
        res.setHeader('Connection', 'close');
        res.setHeader('WWW-Authenticate', 'Bearer');
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
