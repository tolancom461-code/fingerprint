import { discardWithoutCapture } from '../http/http-utils.js';

// This bearer credential cannot authorize device writes or portal management.
export function createSourcePunchesApiHandler({ service, connections, directoryService = null }) {
  return async (req, res, parsedUrl = null) => {
    const url = parsedUrl ?? new URL(req.url || '/', 'http://127.0.0.1');
    const directory = url.pathname === '/api/v1/device-identities';
    if (!directory && url.pathname !== '/api/v1/source-punches') return false;
    const send = (status, body, extra = {}) => {
      const bytes = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'", ...extra });
      res.end(bytes);
      return true;
    };
    try {
      if (req.method !== 'GET') {
        discardWithoutCapture(req);
        return send(405, { error: 'READ_ONLY_API' }, { allow: 'GET' });
      }
      const header = req.headers.authorization;
      let headerCount = 0;
      for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
        if (req.rawHeaders[i].toLowerCase() === 'authorization') headerCount++;
      }
      const token = typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header) ? header.slice(7) : null;
      if (!token || headerCount > 1 || !await connections.authenticate(token)) {
        return send(401, { error: 'AUTH_REQUIRED' }, { 'www-authenticate': 'Bearer' });
      }
      for (const key of url.searchParams.keys()) {
        if (!['after_id', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new TypeError();
      }
      if (directory && !directoryService) return send(503, { error: 'DIRECTORY_API_UNAVAILABLE' });
      return send(200, await (directory ? directoryService : service).list({ afterId: url.searchParams.get('after_id') ?? '0',
        limit: url.searchParams.get('limit') ?? '100' }));
    } catch (error) {
      return send(error instanceof TypeError ? 400 : 503, {
        error: error instanceof TypeError ? 'INVALID_REQUEST' : directory ? 'DIRECTORY_API_UNAVAILABLE' : 'SOURCE_API_UNAVAILABLE'
      });
    }
  };
}
