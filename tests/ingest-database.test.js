import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createIngestDatabase, INGEST_TABLE_PRIVILEGES } from '../src/infrastructure/database/ingest-database.js';
import { BIOMETRIC_TABLES, REQUIRED_BIOMETRIC_COLUMNS, REQUIRED_BIOMETRIC_UNIQUE_INDEXES } from '../src/infrastructure/storage/biometric-table-names.js';
import { TiDbDeviceStore } from '../src/infrastructure/storage/tidb-device-store.js';
import { TiDbIngestStore } from '../src/infrastructure/storage/tidb-ingest-store.js';
import { TiDbPunchStore } from '../src/infrastructure/storage/tidb-punch-store.js';
import { TiDbFinalizationStore } from '../src/infrastructure/storage/tidb-finalization-store.js';
import { FinalizationService } from '../src/application/finalization-service.js';
import { createCanonicalPunchFromIngest } from '../src/domain/punch.js';

const config = { host: 'database.test.invalid', port: 4000, user: 'cluster.ingest_writer', password: 'test-only-password',
  database: 'fingerprint', confirmedName: 'fingerprint', sslMode: 'required',
  connectTimeoutMs: 100, queryTimeoutMs: 100, transactionTimeoutMs: 1000 };
const eligibility = { DATA_TYPE: 'tinyint', COLUMN_TYPE: 'tinyint unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' };

function grants({ bare = false, split = false } = {}) {
  const account = bare ? "'writer'@'%'" : '`writer`@`%`';
  const rows = [`GRANT USAGE ON *.* TO ${account}`];
  for (const [table, privileges] of Object.entries(INGEST_TABLE_PRIVILEGES)) {
    const target = bare ? `fingerprint.${table}` : `\`fingerprint\`.\`${table}\``;
    for (const values of split ? privileges.map(value => [value]) : [privileges]) {
      rows.push(`GRANT ${values.join(', ')} ON ${target} TO ${account}`);
    }
  }
  return rows.map(grant => ({ grant }));
}

function fixture(overrides = {}) {
  const state = { currentDatabase: 'fingerprint', role: 'NONE', grants: grants(), eligibility,
    calls: [], acquired: 0, released: 0, destroyed: 0, begins: 0, commits: 0, rollbacks: 0, ended: 0,
    ...overrides };
  async function answer(options, params = []) {
    state.calls.push({ sql: options.sql, timeout: options.timeout, params });
    const sql = options.sql;
    if (state.failNext) { const error = state.failNext; state.failNext = null; throw error; }
    if (state.hangSql && sql === state.hangSql) return new Promise(() => {});
    if (sql === 'SELECT DATABASE() AS current_database') return [[{ current_database: state.currentDatabase }], []];
    if (sql === 'SELECT CURRENT_ROLE() AS active_roles') return [[{ active_roles: state.role }], []];
    if (sql === 'SHOW GRANTS FOR CURRENT_USER()') return [state.grants, []];
    if (sql.includes('information_schema.COLUMNS')) {
      if (params.at(-1) === 'automatic_finalization_eligible') return [state.eligibility ? [state.eligibility] : [], []];
      return [Object.entries(REQUIRED_BIOMETRIC_COLUMNS).flatMap(([table, columns]) =>
        columns.filter(column => !(state.missingSchema && table === BIOMETRIC_TABLES.devices && column === 'vendor'))
          .map(column => ({ TABLE_NAME: table, COLUMN_NAME: column }))), []];
    }
    if (sql.includes('information_schema.TABLES')) return [Object.values(BIOMETRIC_TABLES)
      .map(TABLE_NAME => ({ TABLE_NAME, TABLE_COLLATION: 'utf8mb4_bin' })), []];
    if (sql.includes('information_schema.STATISTICS')) return [Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES)
      .flatMap(([table, indexes]) => Object.entries(indexes).flatMap(([name, columns]) => columns.map((column, index) =>
        ({ TABLE_NAME: table, INDEX_NAME: name, NON_UNIQUE: 0, SEQ_IN_INDEX: index + 1, COLUMN_NAME: column })))), []];
    if (state.coreFixture) return state.coreFixture(sql, params);
    return sql.trimStart().startsWith('SELECT') ? [[{ value: 7 }], []] : [{ insertId: '21', affectedRows: 1 }, []];
  }
  const createPool = options => {
    state.poolOptions = options;
    return {
      async getConnection() {
        state.acquired++;
        if (state.acquireWait) await state.acquireWait;
        return {
          execute: answer, query: answer,
          async beginTransaction() { state.begins++; if (state.hangBegin) await new Promise(() => {}); },
          async commit() { state.commits++; if (state.hangCommit) await new Promise(() => {}); },
          async rollback() { state.rollbacks++; },
          release() { state.released++; }, destroy() { state.destroyed++; },
        };
      },
      async end() { state.ended++; if (state.hangEnd) await new Promise(() => {}); },
    };
  };
  return { state, createPool };
}

test('writer privilege matrix is immutable and gives writes only to ingest-owned runtime tables', () => {
  assert.equal(Object.isFrozen(INGEST_TABLE_PRIVILEGES), true);
  assert.deepEqual(Object.keys(INGEST_TABLE_PRIVILEGES), Object.values(BIOMETRIC_TABLES));
  for (const [table, values] of Object.entries(INGEST_TABLE_PRIVILEGES)) {
    assert.equal(Object.isFrozen(values), true);
    assert.equal(values.includes('SELECT'), true);
    assert.equal(values.some(value => ['DELETE', 'CREATE', 'ALTER', 'DROP'].includes(value)), false);
    if ([BIOMETRIC_TABLES.people, BIOMETRIC_TABLES.personDeviceUsers, BIOMETRIC_TABLES.auditLog].includes(table)) assert.deepEqual(values, ['SELECT']);
  }
  assert.deepEqual(INGEST_TABLE_PRIVILEGES[BIOMETRIC_TABLES.ingestEvents], ['SELECT', 'INSERT']);
  assert.deepEqual(INGEST_TABLE_PRIVILEGES[BIOMETRIC_TABLES.eventProcessing], ['SELECT', 'INSERT', 'UPDATE']);
});

test('startup validates identity, exact grants, schema and eligibility before exposing a narrow frozen pool', async () => {
  for (const options of [{}, { bare: true }, { bare: true, split: true }]) {
    const f = fixture({ grants: grants(options) });
    const db = await createIngestDatabase(config, { createPool: f.createPool });
    assert.equal(Object.isFrozen(db), true);
    assert.deepEqual(Object.keys(db).sort(), ['checkReady', 'end', 'execute', 'getConnection']);
    assert.deepEqual(await db.checkReady(), { ready: true });
    assert.equal(f.state.calls.filter(call => call.sql === 'SHOW GRANTS FOR CURRENT_USER()').length, 2);
    assert.equal(f.state.calls.some(call => call.params.includes('automatic_finalization_eligible')), true);
    await db.end();
  }
});

test('writer pool pins TLS identity, finite limits and lossless dates, numeric IDs and JSON text', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  assert.deepEqual(f.state.poolOptions.ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true });
  assert.equal(f.state.poolOptions.database, 'fingerprint');
  assert.equal(f.state.poolOptions.connectionLimit, 5); assert.equal(f.state.poolOptions.queueLimit, 10);
  for (const field of ['dateStrings', 'supportBigNumbers', 'bigNumberStrings', 'jsonStrings']) assert.equal(f.state.poolOptions[field], true);
  assert.equal(f.state.poolOptions.multipleStatements, false); assert.equal(f.state.poolOptions.flags, '-LOCAL_FILES');
  assert.equal(f.state.calls.every(call => call.timeout === 100), true);
  await db.end();
});

test('source, unconfirmed, root and remote plaintext configurations never open a pool', async () => {
  let opened = 0; const createPool = () => { opened++; throw new Error('must not open'); };
  for (const change of [{ database: 'test', confirmedName: 'test' }, { database: 'Fingerprint' }, { confirmedName: undefined },
    { confirmedName: 'test' }, { user: 'root' }, { user: 'cluster.root' }, { user: 'ROOT' }, { user: '' },
    { sslMode: 'disabled' }, { connectionLimit: 6 }, { transactionTimeoutMs: 0 }, { port: '4000' }]) {
    await assert.rejects(createIngestDatabase({ ...config, ...change }, { createPool }), { code: 'INGEST_DATABASE_CONFIG_INVALID' });
  }
  assert.equal(opened, 0);
});

test('only explicitly loopback connections can disable TLS', async () => {
  const f = fixture();
  const db = await createIngestDatabase({ ...config, host: '127.0.0.1', sslMode: 'disabled' }, { createPool: f.createPool });
  assert.equal(f.state.poolOptions.ssl, undefined);
  await db.end();
});

test('broad, role, schema, forbidden table, column and extra write privileges fail closed', async () => {
  const rejected = [
    "GRANT ALL PRIVILEGES ON *.* TO 'writer'@'%' WITH GRANT OPTION",
    "GRANT SELECT ON *.* TO 'writer'@'%'", "GRANT SELECT ON fingerprint.* TO 'writer'@'%'",
    "GRANT SELECT ON test.biometric_svc_devices TO 'writer'@'%'",
    "GRANT SELECT ON fingerprint.biometric_portal_test_identity TO 'writer'@'%'",
    "GRANT DELETE ON fingerprint.biometric_svc_devices TO 'writer'@'%'",
    "GRANT UPDATE ON fingerprint.biometric_svc_ingest_events TO 'writer'@'%'",
    "GRANT INSERT ON fingerprint.biometric_svc_people TO 'writer'@'%'",
    "GRANT SELECT (id) ON fingerprint.biometric_svc_devices TO 'writer'@'%'",
    "GRANT `reader`@`%` TO 'writer'@'%'", "GRANT PROXY ON 'other'@'%' TO 'writer'@'%'",
    "GRANT SELECT ON fingerprint.biometric_svc_devices TO 'writer'@'%' WITH GRANT OPTION",
  ];
  for (const grant of rejected) {
    const f = fixture({ grants: [...grants(), { grant }] });
    await assert.rejects(createIngestDatabase(config, { createPool: f.createPool }), { code: 'INGEST_DATABASE_GRANTS_REJECTED' });
    assert.equal(f.state.ended, 1);
  }
  const missing = fixture({ grants: grants().slice(0, -1) });
  await assert.rejects(createIngestDatabase(config, { createPool: missing.createPool }), { code: 'INGEST_DATABASE_GRANTS_REJECTED' });
});

test('different selected databases, active roles, incomplete schema and absent or invalid eligibility close startup', async () => {
  const cases = [
    [{ currentDatabase: 'test' }, 'INGEST_DATABASE_IDENTITY_REJECTED'],
    [{ role: '`active_role`@`%`' }, 'INGEST_DATABASE_GRANTS_REJECTED'],
    [{ missingSchema: true }, 'INGEST_DATABASE_SCHEMA_REJECTED'],
    [{ eligibility: null }, 'INGEST_DATABASE_ELIGIBILITY_SCHEMA_REQUIRED'],
    [{ eligibility: { ...eligibility, COLUMN_TYPE: 'tinyint' } }, 'INGEST_DATABASE_ELIGIBILITY_SCHEMA_REQUIRED'],
    [{ eligibility: { ...eligibility, COLUMN_DEFAULT: null } }, 'INGEST_DATABASE_ELIGIBILITY_SCHEMA_REQUIRED'],
  ];
  for (const [overrides, code] of cases) {
    const f = fixture(overrides);
    await assert.rejects(createIngestDatabase(config, { createPool: f.createPool }), { code });
    assert.equal(f.state.ended, 1);
  }
});

test('SQL guard rejects source or unowned references and unsafe statements before acquiring a connection', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  const before = f.state.acquired;
  for (const sql of [
    'SELECT * FROM test.biometric_svc_devices', 'SELECT * FROM `test`.`biometric_svc_devices`', 'SELECT * FROM mysql.user',
    'SELECT * FROM fingerprint.workers', 'SELECT * FROM biometric_svc_devices d, workers w',
    'INSERT INTO test.biometric_svc_ingest_events (id) VALUES (?)', 'INSERT INTO biometric_svc_people (id) VALUES (?)',
    'UPDATE biometric_svc_final_events SET status = ?', 'UPDATE biometric_svc_ingest_events SET wire_hash = ?',
    'INSERT INTO biometric_svc_ingest_events (id) VALUES (?) ON DUPLICATE KEY UPDATE id=VALUES(id)',
    'DELETE FROM biometric_svc_devices', 'DROP DATABASE fingerprint', 'ALTER TABLE biometric_svc_punches ADD a int',
    'REPLACE INTO biometric_svc_punches (id) VALUES (?)', 'SET ROLE ALL', 'START TRANSACTION',
    'SELECT 1; DELETE FROM biometric_svc_devices', 'SELECT /*hint*/ 1', 'SELECT 1 -- comment', 'SELECT @secret',
    "SELECT 1 INTO OUTFILE '/x'", "SELECT LOAD_FILE('/x')", "SELECT GET_LOCK('x', 10)", 'SELECT SLEEP(10)',
    'SELECT * FROM biometric_svc_devices FOR UPDATE', 'SELECT * FROM biometric_svc_devices LOCK IN SHARE MODE',
    'SELECT * FROM biometric_svc_devices UNION SELECT * FROM mysql.user',
  ]) await assert.rejects(db.execute(sql, ['test-value']), { code: 'INGEST_DATABASE_QUERY_REJECTED' });
  assert.equal(f.state.acquired, before);
  await db.end();
});

test('allowed owned queries retain prepared values and do not interpret SQL-shaped input', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  const params = ["'; DELETE FROM test.workers; --", '{"id":9007199254740993}', Buffer.from([0, 255]), null];
  await db.execute('INSERT INTO fingerprint.biometric_svc_ingest_events (`ingest_key`,`safe_payload`,`wire_hash`,`source_ip`) VALUES (?,?,?,?)', params);
  assert.equal(f.state.calls.at(-1).params, params);
  assert.equal(f.state.calls.at(-1).sql.includes(params[0]), false);
  await db.execute('SELECT d.id,p.id FROM biometric_svc_devices d JOIN biometric_svc_punches p ON p.device_id=d.id WHERE d.id=?', ['7']);
  await db.execute(`SELECT COUNT(*) AS total FROM biometric_svc_ingest_events i
    WHERE JSON_UNQUOTE(JSON_EXTRACT(i.safe_payload, '$.deviceUserId')) = ?
      AND EXISTS (SELECT 1 FROM biometric_svc_punches p WHERE p.ingest_event_id=i.id)`, ['TEST-100']);
  await db.execute("SELECT 'DROP DATABASE test; --' AS harmless_literal");
  await db.end();
});

test('leased transactions preserve duplicate errors without destroying the transaction and can still select then commit', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  const connection = await db.getConnection();
  assert.equal(Object.isFrozen(connection), true);
  assert.deepEqual(Object.keys(connection).sort(), ['beginTransaction', 'commit', 'destroy', 'execute', 'release', 'rollback']);
  await connection.beginTransaction();
  f.state.failNext = Object.assign(new Error('private INSERT SQL and secret password'), { code: 'ER_DUP_ENTRY', errno: 1062, sql: 'secret SQL' });
  await assert.rejects(connection.execute('INSERT INTO biometric_svc_ingest_events (id) VALUES (?)', ['21']), error => {
    assert.equal(error.code, 'ER_DUP_ENTRY'); assert.equal(error.errno, 1062);
    assert.equal(error.sql, undefined); assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /private|password|INSERT/); return true;
  });
  assert.equal(f.state.destroyed, 0);
  await connection.execute('SELECT id FROM biometric_svc_ingest_events WHERE id=?', ['21']);
  await connection.commit(); connection.release();
  assert.equal(f.state.commits, 1);
  await db.end();
});

test('transaction failures are sanitized and discarded while a fresh operation can recover', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  const connection = await db.getConnection(); await connection.beginTransaction();
  f.state.failNext = Object.assign(new Error('private host user password SQL'), { code: 'ER_TEST_FAILURE', sql: 'private SQL' });
  await assert.rejects(connection.execute('INSERT INTO biometric_svc_punches (id) VALUES (?)', ['21']), error => {
    assert.equal(error.code, 'INGEST_DATABASE_UNAVAILABLE'); assert.equal(error.sql, undefined);
    assert.doesNotMatch(error.message, /private|password/); return true;
  });
  assert.equal(f.state.destroyed, 1);
  await assert.rejects(connection.rollback(), { code: 'INGEST_DATABASE_UNAVAILABLE' });
  assert.deepEqual(await db.execute('SELECT 7 AS value'), [[{ value: 7 }], []]);
  await db.end();
});

test('releasing an active transaction destroys it instead of returning uncommitted state to the pool', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  const released = f.state.released;
  const connection = await db.getConnection(); await connection.beginTransaction();
  connection.release();
  assert.equal(f.state.destroyed, 1); assert.equal(f.state.released, released);
  await assert.rejects(connection.commit(), { code: 'INGEST_DATABASE_CONNECTION_CLOSED' });
  await db.end();
});

test('query and transaction deadlines destroy held connections with bounded sanitized errors', async () => {
  const f = fixture(); const db = await createIngestDatabase({ ...config, queryTimeoutMs: 15, transactionTimeoutMs: 50 }, { createPool: f.createPool });
  f.state.hangSql = 'SELECT 7 AS value';
  await assert.rejects(db.execute('SELECT 7 AS value'), { code: 'INGEST_DATABASE_QUERY_TIMEOUT' });
  f.state.hangSql = null;
  const connection = await db.getConnection(); await connection.beginTransaction();
  await delay(60);
  await assert.rejects(connection.execute('SELECT 7 AS value'), { code: 'INGEST_DATABASE_TRANSACTION_TIMEOUT' });
  assert.equal(f.state.destroyed, 2);
  await db.end();
});

test('pool acquisition is bounded and late connections are destroyed rather than exposed', async () => {
  const f = fixture(); const db = await createIngestDatabase({ ...config, connectTimeoutMs: 15 }, { createPool: f.createPool });
  let resolveAcquire; f.state.acquireWait = new Promise(resolve => { resolveAcquire = resolve; });
  await assert.rejects(db.getConnection(), { code: 'INGEST_DATABASE_ACQUIRE_TIMEOUT' });
  resolveAcquire(); await delay(0);
  assert.equal(f.state.destroyed, 1);
  await db.end();
});

test('readiness closes permanently on privilege or schema drift and transient failures can recover', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  f.state.failNext = Object.assign(new Error('private connection details'), { code: 'ECONNRESET' });
  await assert.rejects(db.checkReady(), { code: 'INGEST_DATABASE_UNAVAILABLE' });
  assert.equal(f.state.ended, 0);
  assert.deepEqual(await db.checkReady(), { ready: true });
  f.state.eligibility = null;
  await assert.rejects(db.checkReady(), { code: 'INGEST_DATABASE_ELIGIBILITY_SCHEMA_REQUIRED' });
  assert.equal(f.state.ended, 1);
  await assert.rejects(db.execute('SELECT 7 AS value'), { code: 'INGEST_DATABASE_CLOSED' });
});

test('end cancels active work, destroys leases, closes the pool once and bounds a stalled close', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  const connection = await db.getConnection(); await connection.beginTransaction();
  f.state.hangSql = 'SELECT 7 AS value';
  const pending = assert.rejects(connection.execute('SELECT 7 AS value'), { code: 'INGEST_DATABASE_CLOSED' });
  await delay(0); await db.end(); await pending; await db.end();
  assert.equal(f.state.ended, 1); assert.equal(f.state.destroyed, 1);
  const stalled = fixture(); const db2 = await createIngestDatabase({ ...config, connectTimeoutMs: 15 }, { createPool: stalled.createPool });
  stalled.state.hangEnd = true;
  await assert.rejects(db2.end(), { code: 'INGEST_DATABASE_CLOSE_TIMEOUT' });
});

test('the guard permits actual device, durable capture, canonical processing and finalization store SQL', async () => {
  const f = fixture(); const db = await createIngestDatabase(config, { createPool: f.createPool });
  const payload = { deviceUserId: 'TEST-100', deviceEventTime: '2026-11-09 10:00:00', rawStatus: '0',
    rawVerify: '1', punchState: 'check_in', verificationMethod: 'fingerprint' };
  const ingestRow = { id: '21', device_id: '7', ingest_key: 'a'.repeat(64), storage_identity_version: '1',
    vendor: 'test-vendor', serial_number: 'TEST-1', event_family: 'attendance_punch', vendor_event_type: 'ATTLOG',
    dedupe_key: 'b'.repeat(64), dedupe_strategy: 'test-v1', dedupe_version: '1', wire_hash: 'c'.repeat(64),
    parser_version: 'test-v1', parse_valid: 1, safe_to_acknowledge: 1, safe_payload: JSON.stringify(payload),
    source_bytes: 40, source_field_count: 10, received_at: '2026-11-09 07:00:00' };
  f.state.coreFixture = sql => {
    if (sql.startsWith('INSERT')) return [{ insertId: sql.includes('biometric_svc_punches') ? '40' : '21', affectedRows: 1 }, []];
    if (sql.includes('FROM `biometric_svc_devices`')) return [[{ id: '7', mode: 'live', status: 'active', timezone: 'Asia/Riyadh', accept_events_from: null }], []];
    if (sql.includes('FROM `biometric_svc_ingest_events`')) return [[ingestRow], []];
    if (sql.startsWith('SELECT automatic_finalization_eligible')) return [[{ automatic_finalization_eligible: 1 }], []];
    if (sql.includes('FROM `biometric_svc_punches` p')) return [[{ punch_id: '40', device_id: '7', device_user_id: 'TEST-100',
      device_user_row_id: '8', mapping_id: '9', mapping_status: 'active', mapping_active_to: null, person_id: '10', person_code: 'TEST-100',
      person_status: 'active', punch_state: 'check_in', device_event_time_local: '2026-11-09 10:00:00', device_timezone: 'Asia/Riyadh',
      device_event_time_utc: '2026-11-09 07:00:00', vendor: 'test-vendor', serial_number: 'TEST-1' }], []];
    if (sql.includes('FROM `biometric_svc_final_events`')) return [[{ id: '21', source_punch_id: '40', final_event_uuid: '48d47491-e7bf-4af5-b617-f361f193f5c4' }], []];
    return [{ affectedRows: 1 }, []];
  };
  const devices = new TiDbDeviceStore(db);
  const ingest = new TiDbIngestStore({ pool: db, deviceStore: devices, autoFinalizeNewCaptures: true });
  const captured = await ingest.putIfAbsent({ ingestKey: 'a'.repeat(64), storageIdentityVersion: '1', vendor: 'test-vendor',
    serialNumber: 'TEST-1', eventFamily: 'attendance_punch', vendorEventType: 'ATTLOG', dedupeKey: 'b'.repeat(64), dedupeStrategy: 'test-v1',
    dedupeVersion: '1', wireHash: 'c'.repeat(64), parserVersion: 'test-v1', parseValid: true, safeToAcknowledge: true,
    sourceBytes: 40, sourceFieldCount: 10, canonicalPayload: payload, receivedAt: '2026-11-09T07:00:00Z' });
  assert.equal(captured.record.automaticFinalizationEligible, true);
  const punches = new TiDbPunchStore({ pool: db });
  const stored = await punches.putIfAbsent(createCanonicalPunchFromIngest(captured.record));
  assert.equal(stored.status, 'inserted');
  const finalizer = new FinalizationService({ finalizationStore: new TiDbFinalizationStore(db) });
  assert.equal((await finalizer.finalizePunchById(stored.punchId)).status, 'final');
  assert.equal(f.state.begins, 2); assert.equal(f.state.commits, 2);
  assert.equal(f.state.calls.some(call => call.sql.startsWith('INSERT INTO `biometric_svc_finalization_issues`')), true);
  await db.end();
});
