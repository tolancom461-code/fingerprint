import http from 'node:http';
import { BodyTooLargeError, text } from './http-utils.js';

export function createHttpServer({ adapterRegistry, diagnosticLog }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://biometric.local');

      if (req.method === 'GET' && url.pathname === '/health') {
        return text(res, 200, 'OK');
      }

      const adapter = adapterRegistry.match(req);
      if (!adapter) return text(res, 404, 'NOT_FOUND');
      return await adapter.handle(req, res);
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      try {
        await diagnosticLog.write({
          type: tooLarge ? 'request_too_large' : 'server_error',
          message: error instanceof Error ? error.message : String(error),
          occurredAt: new Date().toISOString()
        });
      } catch {
        // Avoid cascading failures while returning a safe error response.
      }
      return text(res, tooLarge ? 413 : 500, tooLarge ? 'PAYLOAD_TOO_LARGE' : 'ERROR');
    }
  });
}
