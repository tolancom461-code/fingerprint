import { createReadOnlyDatabase } from '../database/read-only-database.js';
import { TiDbAdminReadStore } from '../storage/tidb-admin-read-store.js';
import { createHttpServer } from '../http/server.js';
import { createReadOnlyPortalHandler } from './server.js';

export async function startReadOnlyPortal({ config, openDatabase = createReadOnlyDatabase }) {
  const database = await openDatabase(config.database);
  let server;
  try {
    const handler = createReadOnlyPortalHandler({ config: config.portal, readStore: new TiDbAdminReadStore(database) });
    server = createHttpServer({ adapterRegistry: { match: () => null }, diagnosticLog: { async write() {} },
      portalHandler: async (req, res) => {
        const pathname = new URL(req.url || '/', config.portal.origin).pathname;
        if (req.method === 'GET' && pathname === '/ready') {
          let ready = false;
          try { await database.checkReady(); ready = true; } catch {}
          const body = JSON.stringify({ status: ready ? 'ready' : 'unavailable', mode: 'database-readonly' });
          res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff' });
          res.end(body);
          return true;
        }
        return handler(req, res);
      } });
    server.headersTimeout = 10000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 5000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch {
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await database.end();
    throw Object.assign(new Error('Read-only test portal could not start'), { code: 'READ_PORTAL_START_FAILED' });
  }
  let closing;
  return Object.freeze({ address: server.address(), close() {
    if (closing) return closing;
    closing = (async () => {
      await new Promise(resolve => {
        const timer = setTimeout(() => { server.closeAllConnections(); resolve(); }, 2000);
        timer.unref();
        server.close(() => { clearTimeout(timer); resolve(); });
        server.closeIdleConnections();
      });
      await database.end();
    })();
    return closing;
  } });
}
