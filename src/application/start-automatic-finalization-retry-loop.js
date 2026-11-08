import { AUTOMATIC_FINALIZATION_PENDING_ISSUE } from '../domain/finalization.js';

export function startAutomaticFinalizationRetryLoop({
  finalizationStore,
  finalizationService,
  diagnosticLog,
  intervalSeconds = 10,
  retryDelaySeconds = 30,
  batchLimit = 100,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  if (!finalizationStore) throw new Error('finalizationStore is required');
  if (!finalizationService) throw new Error('finalizationService is required');
  if (!diagnosticLog) throw new Error('diagnosticLog is required');
  const interval = boundedInteger(intervalSeconds, 1, 3600, 'intervalSeconds');
  const delay = boundedInteger(retryDelaySeconds, 1, 3600, 'retryDelaySeconds');
  const limit = boundedInteger(batchLimit, 1, 500, 'batchLimit');

  let running = false;
  let stopped = false;

  const runNow = async () => {
    if (stopped || running) return { skipped: true };
    running = true;
    let punchIds = [];
    let finalCount = 0;
    let unresolvedCount = 0;
    let failedCount = 0;
    try {
      punchIds = await finalizationStore.listOpenIssuePunchIds({
        issueType: AUTOMATIC_FINALIZATION_PENDING_ISSUE,
        retryDelaySeconds: delay,
        limit
      });

      for (const sourcePunchId of punchIds) {
        try {
          const result = await finalizationService.finalizePunchById(sourcePunchId);
          if (result?.status === 'final') finalCount += 1;
          else unresolvedCount += 1;
        } catch (error) {
          failedCount += 1;
          try {
            await finalizationStore.upsertIssue({
              sourcePunchId,
              issueType: AUTOMATIC_FINALIZATION_PENDING_ISSUE,
              details: { errorCode: safeErrorCode(error) }
            });
          } catch {}
          await safeLog(diagnosticLog, {
            type: 'automatic_finalization_retry_failed',
            sourcePunchId,
            errorCode: safeErrorCode(error),
            occurredAt: new Date().toISOString()
          });
        }
      }

      if (punchIds.length > 0) {
        await safeLog(diagnosticLog, {
          type: 'automatic_finalization_retry_sweep_completed',
          eligibleCount: punchIds.length,
          finalCount,
          unresolvedCount,
          failedCount,
          occurredAt: new Date().toISOString()
        });
      }
      return { eligibleCount: punchIds.length, finalCount, unresolvedCount, failedCount };
    } catch (error) {
      await safeLog(diagnosticLog, {
        type: 'automatic_finalization_retry_sweep_failed',
        errorCode: safeErrorCode(error),
        occurredAt: new Date().toISOString()
      });
      return { failed: true, eligibleCount: punchIds.length, finalCount, unresolvedCount, failedCount };
    } finally {
      running = false;
    }
  };

  const timer = setIntervalFn(() => { void runNow(); }, interval * 1000);
  timer?.unref?.();

  return Object.freeze({
    runNow,
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    }
  });
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

function safeErrorCode(error) {
  return String(error?.code ?? error?.errno ?? 'FINALIZATION_ERROR').replace(/[\r\n\0]/g, ' ').slice(0, 100);
}

async function safeLog(log, entry) {
  try { await log.write(entry); } catch {}
}
