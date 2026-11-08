export class AutomaticFinalizingPunchStore {
  constructor({ punchStore, finalizationService, diagnosticLog, clock = () => new Date() }) {
    if (!punchStore) throw new Error('punchStore is required');
    if (!finalizationService) throw new Error('finalizationService is required');
    if (!diagnosticLog) throw new Error('diagnosticLog is required');
    this.punchStore = punchStore;
    this.finalizationService = finalizationService;
    this.diagnosticLog = diagnosticLog;
    this.clock = clock;
  }

  async init() {
    return this.punchStore.init?.();
  }

  async putIfAbsent(punch) {
    const result = await this.punchStore.putIfAbsent(punch, { createAutomaticFinalizationIntent: true });
    if (result?.status !== 'inserted') return result;

    const sourcePunchId = positiveIdOrNull(result.punchId);
    if (sourcePunchId == null) {
      await safeLog(this.diagnosticLog, {
        type: 'automatic_finalization_failed',
        reason: 'inserted_punch_id_missing',
        occurredAt: this.clock().toISOString()
      });
      return {
        ...result,
        automaticFinalization: { status: 'failed', reason: 'inserted_punch_id_missing' }
      };
    }

    try {
      const finalized = await this.finalizationService.finalizePunchById(sourcePunchId);
      if (finalized.status === 'final') {
        await safeLog(this.diagnosticLog, {
          type: 'automatic_finalization_succeeded',
          sourcePunchId,
          finalEventId: positiveIdOrNull(finalized.finalEvent?.id),
          personCode: safeText(finalized.finalEvent?.person_code ?? finalized.finalEvent?.personCode, 64),
          eventType: safeText(finalized.finalEvent?.event_type ?? finalized.finalEvent?.eventType, 64),
          occurredAt: this.clock().toISOString()
        });
      } else {
        await safeLog(this.diagnosticLog, {
          type: 'automatic_finalization_unresolved',
          sourcePunchId,
          issueType: safeText(finalized.issue?.issue_type ?? finalized.issue?.issueType, 64),
          occurredAt: this.clock().toISOString()
        });
      }
      return {
        ...result,
        automaticFinalization: summarize(finalized)
      };
    } catch (error) {
      await safeLog(this.diagnosticLog, {
        type: 'automatic_finalization_failed',
        sourcePunchId,
        errorCode: safeText(error?.code, 100),
        message: safeText(error instanceof Error ? error.message : String(error), 1000),
        occurredAt: this.clock().toISOString()
      });
      // Finalization is downstream from the canonical-punch durability boundary.
      // A finalization failure must never turn an already durable ATTLOG into a failed ACK.
      return {
        ...result,
        automaticFinalization: { status: 'failed' }
      };
    }
  }
}

function summarize(result) {
  if (result?.status === 'final') {
    return {
      status: 'final',
      sourcePunchId: positiveIdOrNull(result.sourcePunchId),
      finalEventId: positiveIdOrNull(result.finalEvent?.id)
    };
  }
  return {
    status: 'unresolved',
    sourcePunchId: positiveIdOrNull(result?.sourcePunchId),
    issueType: safeText(result?.issue?.issue_type ?? result?.issue?.issueType, 64)
  };
}

function positiveIdOrNull(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : text;
}

function safeText(value, max) {
  if (value == null) return null;
  const text = String(value).replace(/[\r\n\0]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

async function safeLog(log, entry) {
  try { await log.write(entry); } catch {}
}
