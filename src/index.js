import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from './config/env.js';
import { ReceivePunchBatch } from './application/receive-punch-batch.js';
import { AutomaticFinalizingPunchStore } from './application/automatic-finalizing-punch-store.js';
import { FinalizationService } from './application/finalization-service.js';
import { StandaloneManagementService } from './application/standalone-management-service.js';
import { StandaloneAdminService } from './application/standalone-admin-service.js';
import { HistoricalFinalEventsReplayService } from './application/historical-final-events-replay-service.js';
import { FinalEventsReadService } from './application/final-events-read-service.js';
import { WebBridgePushService } from './application/web-bridge-push-service.js';
import { PersonDirectoryReadService } from './application/person-directory-read-service.js';
import { replayDurableIngest } from './application/replay-durable-ingest.js';
import { startDurableIngestRetryLoop } from './application/start-durable-ingest-retry-loop.js';
import { startAutomaticFinalizationRetryLoop } from './application/start-automatic-finalization-retry-loop.js';
import { FileDiagnosticLog } from './infrastructure/logging/file-diagnostic-log.js';
import { createHttpServer } from './infrastructure/http/server.js';
import { createAdminServer } from './infrastructure/admin/server.js';
import { createFinalEventsApiServer } from './infrastructure/integration/final-events-api-server.js';
import { EnvDeviceRegistry } from './infrastructure/storage/env-device-registry.js';
import { FilePunchStore } from './infrastructure/storage/file-punch-store.js';
import { FileIngestStore } from './infrastructure/storage/file-ingest-store.js';
import { TiDbDeviceStore } from './infrastructure/storage/tidb-device-store.js';
import { TiDbIngestStore } from './infrastructure/storage/tidb-ingest-store.js';
import { TiDbPunchStore } from './infrastructure/storage/tidb-punch-store.js';
import { TiDbFinalizationStore } from './infrastructure/storage/tidb-finalization-store.js';
import { TiDbPeopleStore } from './infrastructure/storage/tidb-people-store.js';
import { TiDbPersonDeviceUserStore } from './infrastructure/storage/tidb-person-device-user-store.js';
import { TiDbAuditStore } from './infrastructure/storage/tidb-audit-store.js';
import { TiDbAdminReadStore } from './infrastructure/storage/tidb-admin-read-store.js';
import { TiDbHistoricalReplayStore } from './infrastructure/storage/tidb-historical-replay-store.js';
import { TiDbFinalEventsReadStore } from './infrastructure/storage/tidb-final-events-read-store.js';
import { TiDbPersonDirectoryReadStore } from './infrastructure/storage/tidb-person-directory-read-store.js';
import { createBiometricDatabasePool } from './infrastructure/database/mysql-pool.js';
import { assertBiometricDatabaseReady } from './infrastructure/database/schema-check.js';
import { VendorAdapterRegistry } from './infrastructure/vendors/vendor-adapter-registry.js';
import { ZktecoAdmsAdapter } from './infrastructure/vendors/zkteco/http-adapter.js';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(serviceRoot);
const deviceRegistry = new EnvDeviceRegistry(config.allowedDevices);
const diagnosticLog = new FileDiagnosticLog(config.logDir, {
  maxBytes: config.logMaxBytes,
  retainFiles: config.logRetainFiles,
  timezone: config.logTimezone
});
await diagnosticLog.startSession({ serviceVersion: '0.18.0' });

let databasePool = null;
let deviceStore = null;
let ingestStore;
let punchStore;
let databaseReady = null;
let automaticFinalizationActive = false;
let finalizationService = null;
let finalizationStore = null;
let adminServer = null;
let finalEventsApiServer = null;
let webBridgePushService = null;

if (config.storageMode === 'database') {
  databasePool = createBiometricDatabasePool(config.database);
  databaseReady = await assertBiometricDatabaseReady(databasePool, config.database.database);
  deviceStore = new TiDbDeviceStore(databasePool);
  ingestStore = new TiDbIngestStore({
    pool: databasePool,
    deviceStore,
    replayLimit: config.database.replayLimit
  });
  punchStore = new TiDbPunchStore({
    pool: databasePool,
    retryDelaySeconds: config.database.retryDelaySeconds
  });

  finalizationStore = new TiDbFinalizationStore(databasePool);
  finalizationService = new FinalizationService({ finalizationStore });

  if (config.admin.enabled) {
    const peopleStore = new TiDbPeopleStore(databasePool);
    const mappingStore = new TiDbPersonDeviceUserStore(databasePool);
    const auditStore = new TiDbAuditStore(databasePool);
    const adminReadStore = new TiDbAdminReadStore(databasePool);
    const historicalReplayStore = new TiDbHistoricalReplayStore(databasePool);
    const historicalReplayService = new HistoricalFinalEventsReplayService({ replayStore: historicalReplayStore });
    const managementService = new StandaloneManagementService({ peopleStore, mappingStore, auditStore });
    const adminService = new StandaloneAdminService({ managementService, adminReadStore, finalizationService, historicalReplayService });
    adminServer = createAdminServer({ adminService, diagnosticLog });
  }

  if (config.finalEventsApi.enabled || config.webBridge.enabled) {
    const finalEventsReadStore = new TiDbFinalEventsReadStore(databasePool);
    const finalEventsReadService = new FinalEventsReadService({ readStore: finalEventsReadStore });

    if (config.finalEventsApi.enabled) {
      const personDirectoryReadStore = new TiDbPersonDirectoryReadStore(databasePool);
      const personDirectoryReadService = new PersonDirectoryReadService({ readStore: personDirectoryReadStore });
      finalEventsApiServer = createFinalEventsApiServer({
        service: finalEventsReadService,
        personDirectoryService: personDirectoryReadService,
        token: config.finalEventsApi.token,
        diagnosticLog
      });
    }

    if (config.webBridge.enabled) {
      webBridgePushService = new WebBridgePushService({
        finalEventsReadService,
        targetUrl: config.webBridge.targetUrl,
        token: config.webBridge.token,
        stateFile: config.webBridge.stateFile,
        intervalSeconds: config.webBridge.intervalSeconds,
        requestTimeoutSeconds: config.webBridge.requestTimeoutSeconds,
        diagnosticLog
      });
    }
  }
} else {
  ingestStore = new FileIngestStore(config.captureDir);
  punchStore = new FilePunchStore(config.captureDir);
}

await ingestStore.init?.();
await punchStore.init?.();

// Startup replay intentionally uses the base canonical punch store. This preserves
// the no-backfill gate: upgrading the service does not automatically finalize
// historical durable ingest discovered during startup.
const replay = await replayDurableIngest({ ingestStore, punchStore, diagnosticLog });

if (config.storageMode === 'database' && config.autoFinalizeNewPunches) {
  punchStore = new AutomaticFinalizingPunchStore({
    punchStore,
    finalizationService,
    diagnosticLog
  });
  automaticFinalizationActive = true;
}

const receivePunchBatch = new ReceivePunchBatch({
  deviceRegistry,
  ingestStore,
  punchStore,
  diagnosticLog
});

const retryLoop = config.storageMode === 'database'
  ? startDurableIngestRetryLoop({
      ingestStore,
      punchStore,
      diagnosticLog,
      intervalSeconds: config.database.retrySweepSeconds
    })
  : null;

const finalizationRetryLoop = automaticFinalizationActive
  ? startAutomaticFinalizationRetryLoop({
      finalizationStore,
      finalizationService,
      diagnosticLog,
      intervalSeconds: config.database.retrySweepSeconds,
      retryDelaySeconds: config.database.retryDelaySeconds
    })
  : null;

const stopWebBridge = webBridgePushService?.start?.() ?? null;

const zktecoAdapter = new ZktecoAdmsAdapter({
  config: {
    adms: config.zkteco.adms,
    maxBodyBytes: config.maxBodyBytes,
    attlogAckMode: config.attlogAckMode
  },
  deviceRegistry,
  receivePunchBatch,
  diagnosticLog,
  deviceStore
});

const adapterRegistry = new VendorAdapterRegistry([zktecoAdapter]);
const server = createHttpServer({ adapterRegistry, diagnosticLog });

adminServer?.on('error', (error) => {
  console.error(`[biometric-service] admin UI unavailable: ${error?.message ?? error}`);
  void diagnosticLog.write({
    type: 'admin_server_error',
    message: error instanceof Error ? error.message : String(error),
    occurredAt: new Date().toISOString()
  }).catch(() => {});
});

adminServer?.listen(config.admin.port, config.admin.host, () => {
  console.log(`[biometric-service] local admin UI: http://${config.admin.host}:${config.admin.port}`);
  console.log('[biometric-service] admin exposure: loopback only');
});

finalEventsApiServer?.on('error', (error) => {
  console.error(`[biometric-service] Final Events API unavailable: ${error?.message ?? error}`);
  void diagnosticLog.write({
    type: 'final_events_api_server_error',
    message: error instanceof Error ? error.message : String(error),
    occurredAt: new Date().toISOString()
  }).catch(() => {});
});

finalEventsApiServer?.listen(config.finalEventsApi.port, config.finalEventsApi.host, () => {
  console.log(`[biometric-service] Final Events API: http://${config.finalEventsApi.host}:${config.finalEventsApi.port}/api/v1`);
  console.log('[biometric-service] Final Events API exposure: loopback only; bearer authentication required');
  console.log('[biometric-service] Person Directory API: GET /api/v1/person-directory (same read-only listener/auth)');
});

server.listen(config.port, config.host, () => {
  console.log(`[biometric-service] listening on http://${config.host}:${config.port}`);
  console.log(`[biometric-service] allowed devices: ${deviceRegistry.count()}`);
  console.log(`[biometric-service] active vendor adapters: ${adapterRegistry.listVendors().join(', ')}`);
  console.log('[biometric-service] OPTIONS ack policy: acknowledge after safe observation');
  console.log(`[biometric-service] ATTLOG ack mode: ${config.attlogAckMode}`);
  console.log('[biometric-service] ATTLOG durability: sanitized durable ingest before ACK');
  console.log(`[biometric-service] storage mode: ${config.storageMode}`);
  if (!config.finalEventsApi.enabled) console.log('[biometric-service] Final Events API: disabled');
  if (config.webBridge.enabled) {
    console.log(`[biometric-service] web bridge: enabled (push every ${config.webBridge.intervalSeconds}s)`);
    console.log(`[biometric-service] web bridge target: ${new URL(config.webBridge.targetUrl).origin}`);
    console.log('[biometric-service] web bridge first enable: historical Final Events are skipped by cursor initialization');
  } else {
    console.log('[biometric-service] web bridge: disabled');
  }
  console.log(`[biometric-service] diagnostic log rotation: ${config.logMaxBytes} bytes x ${config.logRetainFiles} retained files`);
  console.log(`[biometric-service] diagnostic session: ${diagnosticLog.sessionId} (${config.logTimezone})`);
  if (databaseReady) {
    console.log(`[biometric-service] database schema: ${databaseReady.database} (${databaseReady.tableCount} biometric tables verified)`);
    console.log(`[biometric-service] retry sweep: every ${config.database.retrySweepSeconds}s (retry delay ${config.database.retryDelaySeconds}s)`);
    console.log(`[biometric-service] automatic finalization: ${automaticFinalizationActive ? 'enabled for new canonical punches only' : 'disabled'}`);
    if (automaticFinalizationActive) console.log(`[biometric-service] automatic finalization retry: every ${config.database.retrySweepSeconds}s (retry delay ${config.database.retryDelaySeconds}s; durable pending intents only)`);
    console.log('[biometric-service] automatic historical finalization backfill: disabled');
    console.log('[biometric-service] manual historical Final Events reprocessing: available from local admin UI');
  }
  console.log(`[biometric-service] startup ingest replay: ${replay.failedCount === 0 ? 'ok' : 'partial'} (${replay.eligibleCount} eligible)`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  retryLoop?.stop();
  finalizationRetryLoop?.stop();
  stopWebBridge?.();
  console.log(`[biometric-service] ${signal} received, shutting down`);
  try {
    await Promise.all([closeHttpServer(server), closeHttpServer(adminServer), closeHttpServer(finalEventsApiServer)]);
    await databasePool?.end();
  } finally {
    process.exit(0);
  }
}

function closeHttpServer(httpServer) {
  if (!httpServer || !httpServer.listening) return Promise.resolve();
  return new Promise((resolve) => httpServer.close(() => resolve()));
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
