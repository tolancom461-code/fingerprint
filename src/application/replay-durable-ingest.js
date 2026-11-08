import { createCanonicalPunchFromIngest } from '../domain/punch.js';

export async function replayDurableIngest({
  ingestStore, punchStore, diagnosticLog, clock = () => new Date(),
  completionType = 'durable_ingest_replay_completed', logWhenEmpty = true
}) {
  const records = await ingestStore.list();
  let eligibleCount = 0;
  let insertedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;

  for (const ingest of records) {
    const punch = createCanonicalPunchFromIngest(ingest);
    if (!punch) continue;
    eligibleCount += 1;
    try {
      const result = await punchStore.putIfAbsent(punch);
      if (result.status === 'inserted') insertedCount += 1;
      else duplicateCount += 1;
    } catch (error) {
      failedCount += 1;
      try {
        await diagnosticLog.write({
          type: 'canonical_punch_replay_failed',
          ingestKey: ingest.ingestKey,
          vendor: ingest.vendor,
          serialNumber: ingest.serialNumber,
          message: error instanceof Error ? error.message : String(error),
          occurredAt: clock().toISOString()
        });
      } catch {
        // Continue replaying remaining durable records.
      }
    }
  }

  if (logWhenEmpty || eligibleCount > 0 || failedCount > 0) {
    try {
      await diagnosticLog.write({
      type: completionType,
      recordCount: records.length,
      eligibleCount,
      insertedCount,
      duplicateCount,
      failedCount,
      occurredAt: clock().toISOString()
      });
    } catch {
      // Replay diagnostics are useful, not a runtime dependency.
    }
  }

  return { recordCount: records.length, eligibleCount, insertedCount, duplicateCount, failedCount };
}
