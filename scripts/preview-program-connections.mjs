// Synthetic local UI fixture only. No environment files or database connections.
import http from 'node:http';
import { createCloudIngestPortalHandler } from '../src/infrastructure/portal/server.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';
import { ProgramConnectionsService } from '../src/application/program-connections-service.js';

const rows = new Map();
const service = new ProgramConnectionsService({ store: {
  async assertReady() {}, async list() { return [...rows.values()]; },
  async create(input) {
    const row = { ...input, createdBy: input.actor, status: 'active', createdAtUtc: new Date().toISOString() };
    rows.set(input.id, row); return row;
  },
  async revoke({ id, actor }) { const row = rows.get(id); if (row) { row.status = 'revoked'; row.revokedBy = actor; } return row; },
  async findActiveByTokenHash(hash) { return [...rows.values()].find(row => row.tokenHash === hash && row.status === 'active') ?? null; }
} });
const emptyPage = async query => ({ items: [], page: { number: query.page, limit: query.limit, total: 0, totalPages: 1 } });
const readStore = { async getDashboard() { return { devices: { total: 0 }, people: { total: 0 }, finalEvents: { total: 0 } }; },
  async getIntakeCounts() { return { received: 0, deviceUsers: 0 }; },
  pageDevices: emptyPage, pagePeople: emptyPage, pageFinalEvents: emptyPage, pageReceivedPunches: emptyPage, pageDeviceUsers: emptyPage };
const passwordHash = await hashPassword('Local-only-demo-2026!');
let handler;
const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
handler = createCloudIngestPortalHandler({ config: { origin, users: [{ username: 'preview', passwordHash, role: 'admin' }] }, readStore,
  programConnections: { service, streamId: '35d108c3-6b73-41b1-a4d6-e65dc4db3c74' } });
console.log(`Synthetic preview ${origin}/#program-connections`);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
