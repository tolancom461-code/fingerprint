import { randomUUID } from 'node:crypto';
import { AUTOMATIC_FINALIZATION_PENDING_ISSUE } from '../domain/finalization.js';

export const FINALIZATION_VERSION = 'v1';

export class FinalizationService {
  constructor({ finalizationStore, uuidFactory = randomUUID, finalizationVersion = FINALIZATION_VERSION }) {
    this.finalizationStore = finalizationStore;
    this.uuidFactory = uuidFactory;
    this.finalizationVersion = String(finalizationVersion || FINALIZATION_VERSION);
  }

  async finalizePunchById(punchId) {
    const context = await this.finalizationStore.getPunchContext(punchId);
    if (!context) throw codedError('PUNCH_NOT_FOUND', `punch not found: ${punchId}`);

    const issue = validationIssue(context);
    if (issue) {
      const savedIssue = await this.finalizationStore.upsertIssue({
        sourcePunchId: context.punch_id,
        issueType: issue.type,
        details: issue.details
      });
      await this.finalizationStore.resolveIssue?.(
        context.punch_id,
        AUTOMATIC_FINALIZATION_PENDING_ISSUE,
        'finalization_completed_unresolved'
      );
      return { status: 'unresolved', issue: savedIssue, sourcePunchId: Number(context.punch_id) };
    }

    const event = await this.finalizationStore.createFinalEvent({
      finalEventUuid: this.uuidFactory(),
      personId: context.person_id,
      personCode: context.person_code,
      sourcePunchId: context.punch_id,
      deviceId: context.device_id,
      deviceReference: `${context.vendor}:${context.serial_number}`,
      eventType: context.punch_state,
      eventTimeLocal: context.device_event_time_local,
      eventTimezone: context.device_timezone,
      eventTimeUtc: context.device_event_time_utc,
      verificationMethod: context.verification_method,
      finalizationVersion: this.finalizationVersion,
      safeMetadata: null
    });

    await this.finalizationStore.resolveOpenIssues(context.punch_id, 'finalization_succeeded');
    return { status: 'final', finalEvent: event, sourcePunchId: Number(context.punch_id) };
  }
}

function validationIssue(row) {
  if (!row.device_user_row_id) {
    return safeIssue('unmapped_device_user', row);
  }
  if (!row.mapping_id || !row.person_id) {
    return safeIssue('unmapped_device_user', row);
  }
  if (String(row.mapping_status ?? '').toLowerCase() !== 'active' || row.mapping_active_to != null) {
    return safeIssue('inactive_mapping', row);
  }
  if (String(row.person_status ?? '').toLowerCase() !== 'active') {
    return safeIssue('inactive_person', row);
  }
  if (!String(row.punch_state ?? '').trim()) {
    return safeIssue('unknown_event_type', row);
  }
  if (!row.device_event_time_local || !String(row.device_timezone ?? '').trim() || !row.device_event_time_utc) {
    return safeIssue('invalid_time', row);
  }
  return null;
}

function safeIssue(type, row) {
  return {
    type,
    details: {
      deviceId: numberOrNull(row.device_id),
      deviceUserId: textOrNull(row.device_user_id),
      punchState: textOrNull(row.punch_state),
      personId: numberOrNull(row.person_id),
      personCode: textOrNull(row.person_code)
    }
  };
}
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function textOrNull(value) { const t = String(value ?? '').trim(); return t || null; }
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
