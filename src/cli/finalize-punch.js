import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../config/env.js';
import { createBiometricDatabasePool } from '../infrastructure/database/mysql-pool.js';
import { assertBiometricDatabaseReady } from '../infrastructure/database/schema-check.js';
import { TiDbFinalizationStore } from '../infrastructure/storage/tidb-finalization-store.js';
import { FinalizationService } from '../application/finalization-service.js';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadConfig(serviceRoot);
const punchId = Number(process.argv[2]);

if (!Number.isSafeInteger(punchId) || punchId <= 0) {
  console.error('Usage: node --env-file=.env src/cli/finalize-punch.js <positive-punch-id>');
  process.exitCode = 2;
} else if (config.storageMode !== 'database') {
  console.error('Finalization CLI requires BIOMETRIC_STORAGE_MODE=database');
  process.exitCode = 2;
} else {
  const pool = createBiometricDatabasePool(config.database);
  try {
    await assertBiometricDatabaseReady(pool, config.database.database);
    const service = new FinalizationService({ finalizationStore: new TiDbFinalizationStore(pool) });
    const result = await service.finalizePunchById(punchId);
    console.log(JSON.stringify(toSafeOutput(result), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', code: error?.code ?? 'FINALIZATION_ERROR', message: safeMessage(error) }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function toSafeOutput(result) {
  if (result.status === 'final') {
    const e = result.finalEvent;
    return {
      status: 'final',
      sourcePunchId: result.sourcePunchId,
      finalEvent: {
        id: e.id,
        finalEventUuid: e.final_event_uuid,
        personId: e.person_id,
        personCode: e.person_code,
        eventType: e.event_type,
        eventTimeLocal: e.event_time_local,
        eventTimezone: e.event_timezone,
        eventTimeUtc: e.event_time_utc,
        verificationMethod: e.verification_method,
        finalizationVersion: e.finalization_version,
        status: e.status,
        finalizedAt: e.finalized_at
      }
    };
  }
  return {
    status: 'unresolved',
    sourcePunchId: result.sourcePunchId,
    issue: result.issue ? {
      id: result.issue.id,
      issueType: result.issue.issue_type,
      status: result.issue.status,
      firstSeenAt: result.issue.first_seen_at,
      lastSeenAt: result.issue.last_seen_at
    } : null
  };
}
function safeMessage(error) { return String(error instanceof Error ? error.message : error ?? 'finalization error').replace(/[\r\n\0]/g, ' ').slice(0, 500); }
