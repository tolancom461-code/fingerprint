import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbIngestStore } from '../src/infrastructure/storage/tidb-ingest-store.js';

function ingestEvent(overrides = {}) {
  return {
    ingestKey: 'a'.repeat(64), storageIdentityVersion: '1', vendor: 'zkteco', serialNumber: 'SER1',
    deviceKey: 'zkteco:SER1', eventFamily: 'attendance_punch', vendorEventType: 'ATTLOG',
    vendorEventId: null, dedupeKey: 'b'.repeat(64), dedupeStrategy: 'zkteco-attlog-v1',
    dedupeVersion: '1', wireHash: 'c'.repeat(64), adapterVersion: null, parserVersion: 'parser-v1',
    parseValid: true, safeToAcknowledge: true, unsafeReason: null, sourceBytes: 50,
    sourceFieldCount: 10, captureId: '11111111-1111-1111-1111-111111111111', captureIndex: 0,
    canonicalPayload: { deviceUserId: '900001', deviceEventTime: '2026-08-30 14:00:00', rawStatus: '0', rawVerify: '1', workCode: '0', delimiter: 'tab', extraFields: ['0'] },
    remoteAddress: '192.168.10.199', receivedAt: '2026-08-30T11:00:00.000Z', ...overrides
  };
}

class FakeConnection {
  constructor(row) { this.row = row; this.calls = []; }
  async beginTransaction() { this.calls.push({ type: 'begin' }); }
  async commit() { this.calls.push({ type: 'commit' }); }
  async rollback() { this.calls.push({ type: 'rollback' }); }
  release() { this.calls.push({ type: 'release' }); }
  async execute(sql, params = []) {
    this.calls.push({ type: 'execute', sql, params });
    if (sql.startsWith('INSERT INTO `biometric_svc_ingest_events`')) return [{ insertId: 21, affectedRows: 1 }];
    if (sql.includes('WHERE id = ? LIMIT 1')) return [[this.row]];
    return [{ affectedRows: 1 }];
  }
}

class FakePool {
  constructor(connection) { this.connection = connection; }
  async getConnection() { return this.connection; }
  async execute() { return [[]]; }
}

test('TiDB ingest store commits sanitized ingest and processing state before returning inserted', async () => {
  const event = ingestEvent();
  const row = {
    id: 21, device_id: 7, ingest_key: event.ingestKey, storage_identity_version: '1', vendor: 'zkteco', serial_number: 'SER1',
    event_family: 'attendance_punch', vendor_event_type: 'ATTLOG', vendor_event_id: null,
    dedupe_key: event.dedupeKey, dedupe_strategy: event.dedupeStrategy, dedupe_version: '1', wire_hash: event.wireHash,
    capture_id: event.captureId, capture_index: 0, adapter_version: null, parser_version: 'parser-v1', parse_valid: 1,
    safe_to_acknowledge: 1, unsafe_reason: null, source_bytes: 50, source_field_count: 10,
    safe_payload: JSON.stringify(event.canonicalPayload), source_ip: event.remoteAddress, received_at: '2026-08-30 11:00:00.000000'
  };
  const connection = new FakeConnection(row);
  const store = new TiDbIngestStore({
    pool: new FakePool(connection),
    deviceStore: { async observe() { return { id: 7, status: 'active', mode: 'test', timezone: 'Asia/Riyadh', accept_events_from: null }; } }
  });
  const result = await store.putIfAbsent(event);
  assert.equal(result.status, 'inserted');
  assert.equal(result.record.ingestEventId, 21);
  assert.equal(result.record.deviceId, 7);
  assert.equal(result.record.canonicalPayload.deviceUserId, '900001');
  assert.equal(result.record.deviceTimezone, 'Asia/Riyadh');
  assert.equal(connection.calls.some((c) => c.type === 'commit'), true);
  const insert = connection.calls.find((c) => c.sql?.includes('biometric_svc_ingest_events'));
  assert.equal(String(insert.params).includes('rawLine'), false);
});

test('TiDB ingest store refuses a disabled database device', async () => {
  const connection = new FakeConnection({});
  const store = new TiDbIngestStore({
    pool: new FakePool(connection),
    deviceStore: { async observe() { return { id: 7, status: 'disabled', mode: 'test', timezone: 'Asia/Riyadh', accept_events_from: null }; } }
  });
  await assert.rejects(store.putIfAbsent(ingestEvent()), /status:disabled/);
});

test('unsafe durable ingest is marked not_applicable instead of staying pending forever', async () => {
  const event = ingestEvent({
    parseValid: false,
    safeToAcknowledge: false,
    unsafeReason: 'unrecognized_attlog_shape',
    canonicalPayload: null
  });
  const row = {
    id: 22, device_id: 7, ingest_key: event.ingestKey, storage_identity_version: '1', vendor: 'zkteco', serial_number: 'SER1',
    event_family: 'attendance_punch', vendor_event_type: 'ATTLOG', vendor_event_id: null,
    dedupe_key: event.dedupeKey, dedupe_strategy: event.dedupeStrategy, dedupe_version: '1', wire_hash: event.wireHash,
    capture_id: event.captureId, capture_index: 0, adapter_version: null, parser_version: 'parser-v1', parse_valid: 0,
    safe_to_acknowledge: 0, unsafe_reason: event.unsafeReason, source_bytes: 50, source_field_count: 1,
    safe_payload: null, source_ip: event.remoteAddress, received_at: '2026-08-30 11:00:00.000000'
  };
  const connection = new FakeConnection(row);
  const store = new TiDbIngestStore({
    pool: new FakePool(connection),
    deviceStore: { async observe() { return { id: 7, status: 'active', mode: 'test', timezone: 'Asia/Riyadh', accept_events_from: null }; } }
  });
  await store.putIfAbsent(event);
  const processingInsert = connection.calls.find((c) => c.sql?.includes('biometric_svc_event_processing'));
  assert.equal(processingInsert.params[1], 'not_applicable');
});


test('TiDB ingest stores a pre-cutover event durably but marks canonical processing not_applicable', async () => {
  const event = ingestEvent();
  const row = {
    id: 23, device_id: 7, ingest_key: event.ingestKey, storage_identity_version: '1', vendor: 'zkteco', serial_number: 'SER1',
    event_family: 'attendance_punch', vendor_event_type: 'ATTLOG', vendor_event_id: null,
    dedupe_key: event.dedupeKey, dedupe_strategy: event.dedupeStrategy, dedupe_version: '1', wire_hash: event.wireHash,
    capture_id: event.captureId, capture_index: 0, adapter_version: null, parser_version: 'parser-v1', parse_valid: 1,
    safe_to_acknowledge: 1, unsafe_reason: null, source_bytes: 50, source_field_count: 10,
    safe_payload: JSON.stringify(event.canonicalPayload), source_ip: event.remoteAddress, received_at: '2026-08-30 11:00:00.000000'
  };
  const connection = new FakeConnection(row);
  const store = new TiDbIngestStore({
    pool: new FakePool(connection),
    deviceStore: { async observe() {
      return { id: 7, status: 'active', mode: 'live', timezone: 'Asia/Riyadh', accept_events_from: '2026-08-30 12:00:00.000000' };
    } }
  });
  const result = await store.putIfAbsent(event);
  assert.equal(result.status, 'inserted');
  assert.equal(result.canonicalEligible, false);
  assert.equal(result.policyReason, 'before_accept_events_from');
  const processingInsert = connection.calls.find((c) => c.sql?.includes('biometric_svc_event_processing'));
  assert.equal(processingInsert.params[1], 'not_applicable');
});

test('TiDB replay query carries device timezone and applies runtime device policy', async () => {
  let sql = '';
  const pool = { async execute(statement) { sql = statement; return [[]]; } };
  const store = new TiDbIngestStore({ pool, deviceStore: {}, replayLimit: 100 });
  const rows = await store.list();
  assert.deepEqual(rows, []);
  assert.match(sql, /d\.timezone AS device_timezone/);
  assert.match(sql, /d\.status = 'active'/);
  assert.match(sql, /d\.mode IN \('test', 'live'\)/);
  assert.match(sql, /d\.accept_events_from AS device_accept_events_from/);
  assert.doesNotMatch(sql, /JSON_EXTRACT\(i\.safe_payload/);
});

test('TiDB replay converts device-local time to UTC and retires pre-cutover pending work', async () => {
  const calls = [];
  const row = {
    id: 31, device_id: 7, ingest_key: 'd'.repeat(64), storage_identity_version: '1', vendor: 'zkteco', serial_number: 'SER1',
    event_family: 'attendance_punch', vendor_event_type: 'ATTLOG', vendor_event_id: null,
    dedupe_key: 'e'.repeat(64), dedupe_strategy: 'zkteco-attlog-v1', dedupe_version: '1', wire_hash: 'f'.repeat(64),
    capture_id: null, capture_index: 0, adapter_version: null, parser_version: 'parser-v1', parse_valid: 1,
    safe_to_acknowledge: 1, unsafe_reason: null, source_bytes: 50, source_field_count: 10,
    safe_payload: JSON.stringify({ deviceUserId: '900001', deviceEventTime: '2026-08-31 09:55:17', rawStatus: '0', rawVerify: '1' }),
    source_ip: '192.168.10.199', received_at: '2026-08-31 06:55:17.000000',
    device_timezone: 'Asia/Riyadh', device_mode: 'test', device_status: 'active',
    device_accept_events_from: '2026-08-31 06:55:18.000000'
  };
  const pool = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT i.*')) return [[row]];
      return [{ affectedRows: 1 }];
    }
  };
  const store = new TiDbIngestStore({ pool, deviceStore: {}, replayLimit: 100 });
  const records = await store.list();
  assert.deepEqual(records, []);
  const retired = calls.find((call) => call.sql.includes("VALUES (?, 'not_applicable')"));
  assert.ok(retired);
  assert.deepEqual(retired.params, [31]);
});
