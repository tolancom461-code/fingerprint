import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbFinalizationStore } from '../src/infrastructure/storage/tidb-finalization-store.js';

class FakePool {
  constructor(steps) { this.steps = [...steps]; this.calls = []; }
  async execute(sql, params = []) {
    this.calls.push({ sql, params });
    const step = this.steps.shift();
    if (!step) throw new Error(`unexpected execute: ${sql}`);
    if (step.error) throw step.error;
    return step.value;
  }
}

test('loads finalization context through internal biometric tables only', async () => {
  const row = { punch_id: 30005, device_id: 1, person_id: 1 };
  const pool = new FakePool([{ value: [[row], []] }]);
  const store = new TiDbFinalizationStore(pool);
  const result = await store.getPunchContext(30005);
  assert.equal(result, row);
  const sql = pool.calls[0].sql;
  assert.match(sql, /biometric_svc_punches/);
  assert.match(sql, /biometric_svc_device_users/);
  assert.match(sql, /biometric_svc_person_device_users/);
  assert.match(sql, /biometric_svc_people/);
  assert.doesNotMatch(sql, /\bworkers\b/);
  assert.doesNotMatch(sql, /attendance_events/);
});

test('creates a final event and then reads it back', async () => {
  const insertedRow = { id: 41, final_event_uuid: 'u', source_punch_id: 30005 };
  const pool = new FakePool([
    { value: [{ insertId: 41, affectedRows: 1 }, []] },
    { value: [[insertedRow], []] }
  ]);
  const store = new TiDbFinalizationStore(pool);
  const row = await store.createFinalEvent({
    finalEventUuid: '11111111-1111-4111-8111-111111111111', personId: 1, personCode: '900001', sourcePunchId: 30005,
    deviceId: 1, deviceReference: 'zkteco:AJE1261900133', eventType: 'check_in',
    eventTimeLocal: '2026-08-31 10:31:08', eventTimezone: 'Asia/Riyadh', eventTimeUtc: '2026-08-31 07:31:08',
    verificationMethod: 'fingerprint', finalizationVersion: 'v1', safeMetadata: null
  });
  assert.equal(row.id, 41);
  assert.match(pool.calls[0].sql, /INSERT INTO `biometric_svc_final_events`/);
  assert.equal(pool.calls[0].params.includes('900001'), true);
});

test('duplicate source/version returns the existing immutable final event', async () => {
  const dup = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 });
  const existing = { id: 7, final_event_uuid: 'existing', source_punch_id: 30005, finalization_version: 'v1' };
  const pool = new FakePool([
    { error: dup },
    { value: [[existing], []] }
  ]);
  const store = new TiDbFinalizationStore(pool);
  const row = await store.createFinalEvent({
    finalEventUuid: '22222222-2222-4222-8222-222222222222', personId: 1, personCode: '900001', sourcePunchId: 30005,
    deviceId: 1, deviceReference: 'zkteco:AJE1261900133', eventType: 'check_in',
    eventTimeLocal: '2026-08-31 10:31:08', eventTimezone: 'Asia/Riyadh', eventTimeUtc: '2026-08-31 07:31:08',
    verificationMethod: 'fingerprint', finalizationVersion: 'v1', safeMetadata: null
  });
  assert.equal(row.final_event_uuid, 'existing');
  assert.match(pool.calls[1].sql, /source_punch_id = \? AND finalization_version = \?/);
});

test('upserts one issue per source punch and issue type', async () => {
  const issue = { id: 1, source_punch_id: 30005, issue_type: 'unmapped_device_user', status: 'open' };
  const pool = new FakePool([
    { value: [{ affectedRows: 1 }, []] },
    { value: [[issue], []] }
  ]);
  const store = new TiDbFinalizationStore(pool);
  const result = await store.upsertIssue({ sourcePunchId: 30005, issueType: 'unmapped_device_user', details: { deviceUserId: '900001' } });
  assert.equal(result.issue_type, 'unmapped_device_user');
  assert.match(pool.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.equal(JSON.stringify(pool.calls[0].params).includes('template'), false);
});

test('resolves open issues after successful finalization', async () => {
  const pool = new FakePool([{ value: [{ affectedRows: 2 }, []] }]);
  const store = new TiDbFinalizationStore(pool);
  const result = await store.resolveOpenIssues(30005, 'finalization_succeeded');
  assert.equal(result.affectedRows, 2);
  assert.match(pool.calls[0].sql, /status = 'resolved'/);
});


test('lists only delayed open issues of the requested type for retry', async () => {
  const pool = new FakePool([{ value: [[{ source_punch_id: 61 }, { source_punch_id: 62 }], []] }]);
  const store = new TiDbFinalizationStore(pool);
  const ids = await store.listOpenIssuePunchIds({
    issueType: 'automatic_finalization_pending', retryDelaySeconds: 45, limit: 25
  });
  assert.deepEqual(ids, [61, 62]);
  assert.match(pool.calls[0].sql, /issue_type = \?/);
  assert.match(pool.calls[0].sql, /INTERVAL 45 SECOND/);
  assert.match(pool.calls[0].sql, /LIMIT 25/);
  assert.deepEqual(pool.calls[0].params, ['automatic_finalization_pending']);
});

test('resolves one issue type without closing another unresolved issue for the same punch', async () => {
  const pool = new FakePool([{ value: [{ affectedRows: 1 }, []] }]);
  const store = new TiDbFinalizationStore(pool);
  const result = await store.resolveIssue(30005, 'automatic_finalization_pending', 'finalization_completed_unresolved');
  assert.equal(result.affectedRows, 1);
  assert.match(pool.calls[0].sql, /issue_type = \?/);
  assert.deepEqual(pool.calls[0].params, ['finalization_completed_unresolved', 30005, 'automatic_finalization_pending']);
});
