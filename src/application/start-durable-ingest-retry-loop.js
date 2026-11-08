import { replayDurableIngest } from './replay-durable-ingest.js';

export function startDurableIngestRetryLoop({
  ingestStore,
  punchStore,
  diagnosticLog,
  intervalSeconds = 10,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  const seconds = Number(intervalSeconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error('intervalSeconds must be between 1 and 3600');
  }

  let running = false;
  let stopped = false;

  const runNow = async () => {
    if (stopped || running) return { skipped: true };
    running = true;
    try {
      return await replayDurableIngest({
        ingestStore,
        punchStore,
        diagnosticLog,
        completionType: 'durable_ingest_retry_sweep_completed',
        logWhenEmpty: false
      });
    } catch (error) {
      await safeLog(diagnosticLog, {
        type: 'durable_ingest_retry_sweep_failed',
        message: error instanceof Error ? error.message : String(error),
        occurredAt: new Date().toISOString()
      });
      return { failed: true };
    } finally {
      running = false;
    }
  };

  const timer = setIntervalFn(() => { void runNow(); }, seconds * 1000);
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

async function safeLog(log, entry) {
  try { await log.write(entry); } catch {}
}
