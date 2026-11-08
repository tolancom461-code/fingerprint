import test from 'node:test';
import assert from 'node:assert/strict';
import { FinalizationService } from '../src/application/finalization-service.js';

function baseContext(overrides = {}) {
  return {
    punch_id: 30005,
    device_id: 1,
    device_user_id: '900001',
    punch_state: 'check_in',
    verification_method: 'fingerprint',
    device_event_time_local: '2026-08-31 10:31:08.000000',
    device_timezone: 'Asia/Riyadh',
    device_event_time_utc: '2026-08-31 07:31:08.000000',
    vendor: 'zkteco',
    serial_number: 'AJE1261900133',
    device_user_row_id: 1,
    device_user_status: 'seen',
    mapping_id: 1,
    mapping_status: 'active',
    mapping_active_from: '2026-09-02 10:58:00.000000',
    mapping_active_to: null,
    person_id: 1,
    person_code: '900001',
    display_name: 'Test Person 900001',
    person_status: 'active',
    ...overrides
  };
}

function fixture(context = baseContext()) {
  const created = [];
  const issues = [];
  const resolved = [];
  const resolvedSpecific = [];
  const store = {
    async getPunchContext(id) { return Number(id) === Number(context?.punch_id) ? context : null; },
    async createFinalEvent(event) {
      created.push(event);
      return {
        id: 9,
        final_event_uuid: event.finalEventUuid,
        person_id: event.personId,
        person_code: event.personCode,
        source_punch_id: event.sourcePunchId,
        device_id: event.deviceId,
        device_reference: event.deviceReference,
        event_type: event.eventType,
        event_time_local: event.eventTimeLocal,
        event_timezone: event.eventTimezone,
        event_time_utc: event.eventTimeUtc,
        verification_method: event.verificationMethod,
        finalization_version: event.finalizationVersion,
        status: 'final',
        finalized_at: 'now'
      };
    },
    async upsertIssue(issue) {
      issues.push(issue);
      return { id: 3, source_punch_id: issue.sourcePunchId, issue_type: issue.issueType, status: 'open' };
    },
    async resolveOpenIssues(id, note) { resolved.push({ id, note }); return { affectedRows: 1 }; },
    async resolveIssue(id, issueType, note) { resolvedSpecific.push({ id, issueType, note }); return { affectedRows: 1 }; }
  };
  return { service: new FinalizationService({ finalizationStore: store, uuidFactory: () => '11111111-1111-4111-8111-111111111111' }), created, issues, resolved, resolvedSpecific };
}

test('finalizes a mapped active punch into a vendor-neutral final event', async () => {
  const f = fixture();
  const result = await f.service.finalizePunchById(30005);
  assert.equal(result.status, 'final');
  assert.equal(result.finalEvent.person_code, '900001');
  assert.equal(result.finalEvent.event_type, 'check_in');
  assert.equal(f.created[0].deviceReference, 'zkteco:AJE1261900133');
  assert.equal(f.created[0].finalizationVersion, 'v1');
  assert.equal(f.created[0].safeMetadata, null);
  assert.equal(f.resolved.length, 1);
});

test('manual finalization may resolve a historical punch using the current active identity mapping', async () => {
  const f = fixture(baseContext({
    device_event_time_utc: '2026-08-31 07:31:08.000000',
    mapping_active_from: '2026-09-02 10:58:00.000000'
  }));
  const result = await f.service.finalizePunchById(30005);
  assert.equal(result.status, 'final');
});

test('unmapped device user becomes an unresolved issue instead of guessing', async () => {
  const f = fixture(baseContext({ mapping_id: null, person_id: null, person_code: null }));
  const result = await f.service.finalizePunchById(30005);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.issue.issue_type, 'unmapped_device_user');
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.resolvedSpecific, [{ id: 30005, issueType: 'automatic_finalization_pending', note: 'finalization_completed_unresolved' }]);
});

test('inactive mapping becomes an unresolved issue', async () => {
  const f = fixture(baseContext({ mapping_status: 'inactive', mapping_active_to: '2026-09-02 11:00:00' }));
  const result = await f.service.finalizePunchById(30005);
  assert.equal(result.issue.issue_type, 'inactive_mapping');
});

test('inactive person becomes an unresolved issue', async () => {
  const f = fixture(baseContext({ person_status: 'inactive' }));
  const result = await f.service.finalizePunchById(30005);
  assert.equal(result.issue.issue_type, 'inactive_person');
});

test('unknown punch state is not finalized', async () => {
  const f = fixture(baseContext({ punch_state: null }));
  const result = await f.service.finalizePunchById(30005);
  assert.equal(result.issue.issue_type, 'unknown_event_type');
});

test('missing canonical UTC time is not finalized', async () => {
  const f = fixture(baseContext({ device_event_time_utc: null }));
  const result = await f.service.finalizePunchById(30005);
  assert.equal(result.issue.issue_type, 'invalid_time');
});

test('issue details are sanitized and do not include raw payload or biometric data', async () => {
  const f = fixture(baseContext({ mapping_id: null, person_id: null }));
  await f.service.finalizePunchById(30005);
  const serialized = JSON.stringify(f.issues[0]);
  assert.equal(serialized.includes('wireHash'), false);
  assert.equal(serialized.includes('template'), false);
  assert.equal(serialized.includes('password'), false);
});

test('missing punch returns a coded error', async () => {
  const f = fixture(null);
  await assert.rejects(f.service.finalizePunchById(123), (e) => e.code === 'PUNCH_NOT_FOUND');
});
