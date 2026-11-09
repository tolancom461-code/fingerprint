import { createIngestDatabase } from '../database/ingest-database.js';
import { TiDbDeviceStore } from '../storage/tidb-device-store.js';
import { TiDbIngestStore } from '../storage/tidb-ingest-store.js';
import { TiDbPunchStore } from '../storage/tidb-punch-store.js';
import { TiDbFinalizationStore } from '../storage/tidb-finalization-store.js';
import { TiDbIngestReadStore } from '../storage/tidb-ingest-read-store.js';
import { EnvDeviceRegistry } from '../storage/env-device-registry.js';
import { FinalizationService } from '../../application/finalization-service.js';
import { AutomaticFinalizingPunchStore } from '../../application/automatic-finalizing-punch-store.js';
import { ReceivePunchBatch } from '../../application/receive-punch-batch.js';
import { replayDurableIngest } from '../../application/replay-durable-ingest.js';
import { startDurableIngestRetryLoop } from '../../application/start-durable-ingest-retry-loop.js';
import { startAutomaticFinalizationRetryLoop } from '../../application/start-automatic-finalization-retry-loop.js';
import { VendorAdapterRegistry } from '../vendors/vendor-adapter-registry.js';
import { ZktecoAdmsAdapter } from '../vendors/zkteco/http-adapter.js';
import { createHttpServer } from '../http/server.js';
import { createCloudIngestPortalHandler } from '../portal/server.js';
import { createAuthenticatedRegistry } from './authenticated-registry.js';

const defaultLog = Object.freeze({ async write(entry) { process.stdout.write(JSON.stringify(entry) + '\n'); } });
const LOG_TYPES = new Set([
  'cloud_ingest_started', 'cloud_ingest_stopped', 'machine_auth_rejected', 'device_rejected', 'device_policy_rejected',
  'device_request', 'device_options_observed', 'device_operlog_observed', 'devicecmd_result_observed',
  'biometric_payload_discarded', 'unsupported_cdata_discarded', 'punch_batch', 'canonical_punch_processing_failed',
  'canonical_punch_replay_failed', 'durable_ingest_replay_completed', 'durable_ingest_retry_sweep_completed',
  'durable_ingest_retry_sweep_failed', 'automatic_finalization_failed', 'automatic_finalization_succeeded',
  'automatic_finalization_unresolved', 'automatic_finalization_retry_failed',
  'automatic_finalization_retry_sweep_completed', 'automatic_finalization_retry_sweep_failed', 'server_error', 'request_too_large'
]);
const LOG_COUNTS = ['lineCount', 'validCount', 'invalidCount', 'unsafeCount', 'acceptedCount', 'duplicateCount',
  'canonicalInsertedCount', 'canonicalDuplicateCount', 'canonicalPendingCount', 'canonicalNotApplicableCount',
  'recordCount', 'eligibleCount', 'insertedCount', 'failedCount', 'finalCount', 'unresolvedCount'];

// No environment/configuration imports, filesystem captures, legacy administration,
// integration API or outbound consumer run in this listener.
export async function startCloudIngest({ config, openDatabase = createIngestDatabase, diagnosticLog = defaultLog } = {}) {
  let database;
  let server;
  let retryLoop;
  let finalizationRetryLoop;
  const log = sanitizedLog(diagnosticLog);
  try {
    validateRuntimeConfig(config);
    database = await openDatabase(config.database);
    await database.checkReady();
    const deviceRegistry = new EnvDeviceRegistry(config.allowedDevices);
    const deviceStore = new TiDbDeviceStore(database);
    const ingestStore = new TiDbIngestStore({ pool: database, deviceStore, replayLimit: config.replayLimit,
      autoFinalizeNewCaptures: config.autoFinalizeNewPunches });
    const basePunchStore = new TiDbPunchStore({ pool: database, retryDelaySeconds: config.retryDelaySeconds });
    const finalizationStore = new TiDbFinalizationStore(database);
    const finalizationService = new FinalizationService({ finalizationStore });
    await ingestStore.init();
    await basePunchStore.init();
    await replayDurableIngest({ ingestStore, punchStore: basePunchStore, diagnosticLog: log });
    const punchStore = config.autoFinalizeNewPunches ? new AutomaticFinalizingPunchStore({
      punchStore: basePunchStore, finalizationService, diagnosticLog: log, requireDurableEligibility: true
    }) : basePunchStore;
    const receivePunchBatch = new ReceivePunchBatch({ deviceRegistry, ingestStore, punchStore, diagnosticLog: log });
    const adapter = new ZktecoAdmsAdapter({ config: { adms: config.adms, maxBodyBytes: config.maxBodyBytes, attlogAckMode: 'ack' },
      deviceRegistry, receivePunchBatch, diagnosticLog: log, deviceStore });
    const registry = createAuthenticatedRegistry({ registry: new VendorAdapterRegistry([adapter]), token: config.token,
      diagnosticLog: log });
    const portal = createCloudIngestPortalHandler({ config: config.portal, readStore: new TiDbIngestReadStore(database) });
    server = createHttpServer({ adapterRegistry: registry, diagnosticLog: log,
      portalHandler: async (req, res) => {
        const pathname = new URL(req.url || '/', config.portal.origin).pathname;
        if (req.method === 'GET' && pathname === '/ready') {
          let ready = false;
          try { await database.checkReady(); ready = true; } catch {}
          const body = JSON.stringify({ status: ready ? 'ready' : 'unavailable', mode: 'database-ingest' });
          res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff' });
          res.end(body);
          return true;
        }
        return portal(req, res);
      } });
    server.headersTimeout = 10000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 5000;
    retryLoop = startDurableIngestRetryLoop({ ingestStore, punchStore, diagnosticLog: log,
      intervalSeconds: config.retrySweepSeconds });
    finalizationRetryLoop = config.autoFinalizeNewPunches ? startAutomaticFinalizationRetryLoop({
      finalizationStore, finalizationService, diagnosticLog: log,
      intervalSeconds: config.retrySweepSeconds, retryDelaySeconds: config.retryDelaySeconds
    }) : null;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
    });
    await log.write({ type: 'cloud_ingest_started' });
  } catch {
    retryLoop?.stop();
    finalizationRetryLoop?.stop();
    await closeServer(server);
    try { await database?.end(); } catch {}
    throw Object.assign(new Error('The authenticated cloud ingest listener could not start'), { code: 'CLOUD_INGEST_START_FAILED' });
  }
  let closing;
  return Object.freeze({ address: Object.freeze({ ...server.address() }), close() {
    if (closing) return closing;
    retryLoop?.stop();
    finalizationRetryLoop?.stop();
    closing = (async () => {
      await closeServer(server);
      await database.end();
      await log.write({ type: 'cloud_ingest_stopped' });
    })();
    return closing;
  } });
}

function sanitizedLog(sink) {
  return Object.freeze({ async write(entry) {
    const clean = { type: LOG_TYPES.has(entry?.type) ? entry.type : 'diagnostic', occurredAt: new Date().toISOString() };
    for (const field of LOG_COUNTS) {
      const value = entry?.[field];
      if (Number.isSafeInteger(value) && value >= 0) clean[field] = value;
    }
    try { await sink?.write(clean); } catch { /* Diagnostics do not alter the durable ACK decision. */ }
  } });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { server.closeAllConnections(); resolve(); }, 2000);
    timer.unref();
    server.close(() => { clearTimeout(timer); resolve(); });
    server.closeIdleConnections();
  });
}

function validateRuntimeConfig(config) {
  if (!config || typeof config !== 'object' || !['127.0.0.1', '0.0.0.0', '::1'].includes(config.host) ||
      !Number.isInteger(config.port) || config.port < 0 || config.port > 65535 ||
      typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(config.token) ||
      !Array.isArray(config.allowedDevices) || config.allowedDevices.length === 0 ||
      config.allowedDevices.some(value => typeof value !== 'string' || !/^zkteco:[A-Za-z0-9._-]{1,128}$/.test(value)) ||
      typeof config.autoFinalizeNewPunches !== 'boolean' || !config.database || !config.portal ||
      !Number.isInteger(config.maxBodyBytes) || config.maxBodyBytes < 1024 || config.maxBodyBytes > 10485760 ||
      ![config.retrySweepSeconds, config.retryDelaySeconds].every(value => Number.isInteger(value) && value >= 1 && value <= 3600) ||
      !Number.isInteger(config.replayLimit) || config.replayLimit < 1 || config.replayLimit > 10000 || !config.adms) {
    throw new Error('Invalid cloud ingest runtime configuration');
  }
}
