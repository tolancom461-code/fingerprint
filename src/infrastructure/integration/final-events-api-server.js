import crypto from 'node:crypto';
import http from 'node:http';

export function createFinalEventsApiServer({ service, personDirectoryService = null, token, diagnosticLog }) {
  const expectedToken = String(token ?? '');
  if (expectedToken.length < 32) throw new Error('Final Events API token must be at least 32 characters');

  return http.createServer(async (req, res) => {
    try {
      setSecurityHeaders(res);
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/api/v1/health') {
        return json(res, 200, { ok: true, service: 'biometric-final-events-api', apiVersion: 'v1' });
      }

      if (isProtectedReadPath(url.pathname)) {
        if (req.method !== 'GET') return json(res, 405, { error: 'READ_ONLY_API', message: 'This API is read-only' }, { allow: 'GET' });
        enforceBearer(req, expectedToken);
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
      const status = httpStatus(error);
      try {
        await diagnosticLog?.write?.({
          type: 'final_events_api_request_error',
          errorCode: error?.code ?? 'FINAL_EVENTS_API_ERROR',
          method: req.method,
          path: safePath(req.url),
          occurredAt: new Date().toISOString()
        });
      } catch {
        // API responses must not depend on diagnostic logging.
      }
      const headers = status === 401 ? { 'www-authenticate': 'Bearer' } : undefined;
      return json(res, status, { error: error?.code ?? 'FINAL_EVENTS_API_ERROR', message: safeMessage(error) }, headers);
    }
  });
}

function isProtectedReadPath(pathname) {
  return pathname === '/api/v1/final-events'
    || pathname.startsWith('/api/v1/final-events/')
    || pathname === '/api/v1/person-directory';
}

function enforceBearer(req, expectedToken) {
  const authorization = String(req.headers.authorization ?? '');
  if (!authorization.startsWith('Bearer ')) throw codedError('AUTH_REQUIRED', 'Bearer token required');
  const provided = authorization.slice(7).trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw codedError('AUTH_REQUIRED', 'Bearer token required');
}

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

function safePath(rawUrl) {
  try { return new URL(rawUrl || '/', 'http://127.0.0.1').pathname; }
  catch { return '/'; }
}

function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
