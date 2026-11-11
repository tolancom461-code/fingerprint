import crypto from 'node:crypto';
import http from 'node:http';
import { discardWithoutCapture } from '../http/http-utils.js';
import { isConsumerApiToken } from './consumer-api-credentials.js';

export function createFinalEventsApiServer(options) {
  const handle = createFinalEventsApiHandler({ ...options, legacyLoopback: true });
  return http.createServer(async (req, res) => {
    if (await handle(req, res)) return;
    setSecurityHeaders(res);
    json(res, 404, { error: 'NOT_FOUND', message: 'Not found' });
  });
}

export function createFinalEventsApiHandler({ service, personDirectoryService = null, token, diagnosticLog, legacyLoopback = false }) {
  const expectedToken = legacyLoopback ? String(token ?? '') : token;
  if (legacyLoopback ? expectedToken.length < 32 : !isConsumerApiToken(expectedToken)) {
    throw new Error(legacyLoopback ? 'Final Events API token must be at least 32 characters' : 'Invalid consumer API configuration');
  }
  const expected = digest(expectedToken);

  return async (req, res, parsedUrl = null) => {
    try {
      const url = parsedUrl ?? new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/v1/health' && !isProtectedReadPath(url.pathname)) return false;
      setSecurityHeaders(res);

      if (req.method === 'GET' && url.pathname === '/api/v1/health') {
        return json(res, 200, { ok: true, service: 'biometric-final-events-api', apiVersion: 'v1' });
      }

      if (isProtectedReadPath(url.pathname)) {
        if (req.method !== 'GET') {
          if (!legacyLoopback) discardWithoutCapture(req);
          return json(res, 405, { error: 'READ_ONLY_API', message: 'This API is read-only' }, { allow: 'GET' });
        }
        enforceBearer(req, expected, legacyLoopback);
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/final-events') {
        const afterId = url.searchParams.get('after_id') ?? '0';
        const limit = url.searchParams.get('limit') ?? '100';
        return json(res, 200, await service.list({ afterId, limit }));
      }

      const eventMatch = url.pathname.match(/^\/api\/v1\/final-events\/([^/]+)$/);
      if (req.method === 'GET' && eventMatch) {
        return json(res, 200, await service.getByUuid(decodeURIComponent(eventMatch[1])));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/person-directory') {
        if (!personDirectoryService) return json(res, 503, { error: 'PERSON_DIRECTORY_UNAVAILABLE', message: 'Person directory unavailable' });
        return json(res, 200, await personDirectoryService.list({
          search: url.searchParams.get('search') ?? '',
          status: url.searchParams.get('status') ?? 'active',
          afterCode: url.searchParams.get('after_code') ?? '',
          limit: url.searchParams.get('limit') ?? '100'
        }));
      }

      return json(res, 404, { error: 'NOT_FOUND', message: 'Not found' });
    } catch (error) {
      setSecurityHeaders(res);
      const status = httpStatus(error);
      const body = legacyLoopback
        ? { error: error?.code ?? 'FINAL_EVENTS_API_ERROR', message: safeMessage(error) }
        : cloudError(status);
      if (!legacyLoopback) discardWithoutCapture(req);
      try {
        await diagnosticLog?.write?.({
          type: 'final_events_api_request_error',
          errorCode: body.error,
          ...(legacyLoopback ? { method: req.method, path: safePath(req.url) } : {}),
          occurredAt: new Date().toISOString()
        });
      } catch {
        // API responses must not depend on diagnostic logging.
      }
      const headers = status === 401 ? { 'www-authenticate': 'Bearer' } : undefined;
      return json(res, status, body, headers);
    }
  };
}

function isProtectedReadPath(pathname) {
  return pathname === '/api/v1/final-events'
    || pathname.startsWith('/api/v1/final-events/')
    || pathname === '/api/v1/person-directory';
}

function enforceBearer(req, expected, legacyLoopback) {
  const authorization = legacyLoopback ? String(req.headers.authorization ?? '') : req.headers.authorization;
  const provided = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7) : null;
  const candidate = legacyLoopback ? provided?.trim() : provided;
  if (!candidate || (!legacyLoopback && (!isConsumerApiToken(candidate) || duplicateAuthorization(req))) ||
      !crypto.timingSafeEqual(digest(candidate), expected)) throw codedError('AUTH_REQUIRED', 'Bearer token required');
}

function duplicateAuthorization(req) {
  let count = 0;
  const headers = req.rawHeaders ?? [];
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index].toLowerCase() === 'authorization' && ++count > 1) return true;
  }
  return false;
}

function digest(value) { return crypto.createHash('sha256').update(value, 'utf8').digest(); }

function setSecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

function json(res, status, value, extraHeaders = undefined) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...(extraHeaders ?? {})
  });
  res.end(body);
  return true;
}

function httpStatus(error) {
  if (error?.code === 'AUTH_REQUIRED') return 401;
  if (error?.code === 'FINAL_EVENT_NOT_FOUND') return 404;
  if (error instanceof TypeError || error instanceof URIError) return 400;
  return 500;
}

function safeMessage(error) {
  if (error?.code === 'AUTH_REQUIRED' || error?.code === 'FINAL_EVENT_NOT_FOUND' || error instanceof TypeError || error instanceof URIError) {
    return error.message;
  }
  return 'Unexpected server error';
}

function cloudError(status) {
  if (status === 401) return { error: 'AUTH_REQUIRED', message: 'Bearer token required' };
  if (status === 404) return { error: 'FINAL_EVENT_NOT_FOUND', message: 'Final event not found' };
  if (status === 400) return { error: 'INVALID_REQUEST', message: 'Invalid request' };
  return { error: 'FINAL_EVENTS_API_ERROR', message: 'Unexpected server error' };
}

function safePath(rawUrl) {
  try { return new URL(rawUrl || '/', 'http://127.0.0.1').pathname; }
  catch { return '/'; }
}

function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
