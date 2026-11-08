import crypto from 'node:crypto';
import { createIngestEvent } from '../domain/ingest-event.js';
import { createCanonicalPunchFromIngest } from '../domain/punch.js';

export class ReceivePunchBatch {
  constructor({ deviceRegistry, ingestStore, punchStore, diagnosticLog, clock = () => new Date() }) {
    this.deviceRegistry = deviceRegistry;
    this.ingestStore = ingestStore;
    this.punchStore = punchStore;
    this.diagnosticLog = diagnosticLog;
    this.clock = clock;
  }

  async execute({ device, observations, remoteAddress }) {
    if (!this.deviceRegistry.isAllowed(device)) {
      await this.diagnosticLog.write({
        type: 'device_rejected',
        vendor: device?.vendor ?? null,
        serialNumber: device?.serialNumber ?? null,
        remoteAddress,
        occurredAt: this.clock().toISOString()
      });
      return emptyResult(false);
    }

    const items = Array.isArray(observations) ? observations : [];
    let acceptedCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    let unsafeCount = 0;
    let canonicalInsertedCount = 0;
    let canonicalDuplicateCount = 0;
    let canonicalPendingCount = 0;
    let canonicalNotApplicableCount = 0;
    const receivedAt = this.clock().toISOString();
    const captureId = crypto.randomUUID();

    for (const [captureIndex, observation] of items.entries()) {
      if (!observation.parseValid) invalidCount += 1;

      const ingest = createIngestEvent({ device, observation, receivedAt, remoteAddress, captureId, captureIndex });

      // This is the acknowledgement durability boundary. If this throws,
      // the HTTP request fails and the device must retry.
      const durable = await this.ingestStore.putIfAbsent(ingest);
      if (durable.status === 'inserted') acceptedCount += 1;
      else duplicateCount += 1;

      const canonicalSource = durable.record || ingest;
      if (!observation.safeToAcknowledge || !canonicalSource.safeToAcknowledge) unsafeCount += 1;

      if (durable.canonicalEligible === false) {
        canonicalNotApplicableCount += 1;
        continue;
      }

      const punch = createCanonicalPunchFromIngest(canonicalSource);
      if (!punch) continue;

      // Canonical processing intentionally occurs after durable capture.
      // A failure here must not erase the safely persisted source event.
      try {
        const processed = await this.punchStore.putIfAbsent(punch);
        if (processed.status === 'inserted') canonicalInsertedCount += 1;
        else canonicalDuplicateCount += 1;
      } catch (error) {
        canonicalPendingCount += 1;
        await safeDiagnosticWrite(this.diagnosticLog, {
          type: 'canonical_punch_processing_failed',
          vendor: ingest.vendor,
          serialNumber: ingest.serialNumber,
          ingestKey: ingest.ingestKey,
          message: error instanceof Error ? error.message : String(error),
          occurredAt: this.clock().toISOString()
        });
      }
    }

    const safeToAcknowledge = items.length > 0 && unsafeCount === 0;

    await this.diagnosticLog.write({
      type: 'punch_batch',
      vendor: device.vendor,
      serialNumber: device.serialNumber,
      remoteAddress,
      lineCount: items.length,
      validCount: items.length - invalidCount,
      invalidCount,
      unsafeCount,
      acceptedCount,
      duplicateCount,
      canonicalInsertedCount,
      canonicalDuplicateCount,
      canonicalPendingCount,
      canonicalNotApplicableCount,
      safeToAcknowledge,
      occurredAt: receivedAt
    });

    return {
      allowed: true,
      parsedCount: items.length,
      acceptedCount,
      duplicateCount,
      invalidCount,
      unsafeCount,
      canonicalInsertedCount,
      canonicalDuplicateCount,
      canonicalPendingCount,
      canonicalNotApplicableCount,
      safeToAcknowledge
    };
  }
}

function emptyResult(allowed) {
  return {
    allowed,
    parsedCount: 0,
    acceptedCount: 0,
    duplicateCount: 0,
    invalidCount: 0,
    unsafeCount: 0,
    canonicalInsertedCount: 0,
    canonicalDuplicateCount: 0,
    canonicalPendingCount: 0,
    canonicalNotApplicableCount: 0,
    safeToAcknowledge: false
  };
}

async function safeDiagnosticWrite(log, entry) {
  try {
    await log.write(entry);
  } catch {
    // The source event is already durable. Diagnostic logging must not change
    // the acknowledgement decision after the durability boundary.
  }
}
