import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTiDbTestPortal } from '../scripts/setup-tidb-test-portal.mjs';
import {
  BIOMETRIC_TABLES, REQUIRED_BIOMETRIC_COLUMNS, REQUIRED_BIOMETRIC_UNIQUE_INDEXES
} from '../src/infrastructure/storage/biometric-table-names.js';

const markerTable = 'biometric_portal_test_identity';
const expectedTables = [...Object.values(BIOMETRIC_TABLES), markerTable];
const privatePath = '/unit-fixture/private/readonly.env';
const reportPath = '/unit-fixture/public/setup-report.json';
const userPrefix = 'Ab12Cd34Ef56Gh78';

function environment(overrides = {}) {
  return { TIDB_SETUP_HOST: 'fixture.invalid', TIDB_SETUP_PORT: '4000', TIDB_SETUP_USER: `${userPrefix}.root`,
    TIDB_SETUP_PASSWORD: 'Synthetic-setup-password!2026', TIDB_SETUP_DATABASE: 'fingerprint', ...overrides };
}

function fixture(overrides = {}) {
  const state = { calls: [], connections: [], files: new Map(), writes: [], reports: [], tables: [],
    selectedDatabase: 'fingerprint', setupPrivileges: ['SELECT', 'INSERT', 'CREATE', 'CREATE USER'], grantOption: true,
    marker: null, readerGrants: [], closed: [], destroyed: [], ...overrides };
  const fileStore = {
    async exists(file) { return state.files.has(file); },
    async writeExclusive(file, text) {
      state.writes.push({ file, text, callCount: state.calls.length });
      if (state.files.has(file) || state.failExclusive) throw Object.assign(new Error('Private existing fixture file'), { code: 'EEXIST' });
      state.files.set(file, text);
    },
    async writeReport(file, text) { state.reports.push({ file, text }); }
  };
  async function answer(kind, method, options, params = []) {
    const { sql, timeout } = options;
    state.calls.push({ kind, method, sql, params, timeout });
    if (state.failSql?.(sql)) throw Object.assign(new Error(state.failureMessage || 'Synthetic private SQL failure'), { code: 'ER_TEST_DDL' });
    if (sql === 'SELECT DATABASE() AS current_database') return [[{ current_database: state.selectedDatabase }], []];
    if (sql === 'SELECT CURRENT_ROLE() AS active_roles') return [[{ active_roles: 'NONE' }], []];
    if (sql === 'SHOW GRANTS FOR CURRENT_USER()') {
      const grants = kind === 'reader' ? state.readerGrants.map((grant, index) =>
        state.readerGrantTransform ? state.readerGrantTransform(grant, index) : grant) : [
        `GRANT ${state.setupPrivileges.join(', ')} ON *.* TO '${userPrefix}.root'@'%'${state.grantOption ? ' WITH GRANT OPTION' : ''}`
      ];
      return [grants.map(grant => ({ Grant: grant })), []];
    }
    if (sql.includes('information_schema.TABLES') && sql.includes('TABLE_TYPE')) return [state.tables, []];
    if (sql.includes('information_schema.COLUMNS')) return [Object.entries(REQUIRED_BIOMETRIC_COLUMNS)
      .flatMap(([table, columns]) => columns.map(column => ({ TABLE_NAME: table, COLUMN_NAME: column }))), []];
    if (sql.includes('information_schema.TABLES')) return [expectedTables.map(table => ({ TABLE_NAME: table, TABLE_COLLATION: 'utf8mb4_bin' })), []];
    if (sql.includes('information_schema.STATISTICS')) return [Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES)
      .flatMap(([table, indexes]) => Object.entries(indexes).flatMap(([name, columns]) => columns.map((column, index) =>
        ({ TABLE_NAME: table, INDEX_NAME: name, NON_UNIQUE: 0, SEQ_IN_INDEX: index + 1, COLUMN_NAME: column })))), []];
    if (/^CREATE TABLE\b/.test(sql)) {
      const table = /^CREATE TABLE\s+`?([a-z0-9_]+)`?/i.exec(sql)?.[1];
      state.tables.push({ TABLE_NAME: table, TABLE_TYPE: 'BASE TABLE' });
      return [{ affectedRows: 0 }, []];
    }
    if (sql.startsWith(`INSERT INTO ${markerTable}`)) state.marker = { purpose: params[0], instance_id: params[1] };
    if (/^GRANT SELECT\b/.test(sql)) { state.readerGrants.push(sql); return [{ affectedRows: 0 }, []]; }
    if (sql === `SELECT purpose, instance_id FROM \`${markerTable}\``) return [[state.marker], []];
    if (sql.startsWith('SELECT final_event_uuid, event_time_utc')) return [[{
      final_event_uuid: '48d47491-e7bf-4af5-b617-f361f193f5c4', event_time_utc: '2026-11-09 07:15:00.123456'
    }], []];
    if (sql.startsWith('SELECT COUNT(*) AS total')) return [[{ total: 1 }], []];
    if (/^(?:INSERT|CREATE USER)\b/.test(sql)) return [{ affectedRows: 1 }, []];
    throw new Error(`Unexpected synthetic query: ${sql}`);
  }
  const createConnection = async options => {
    const kind = options.user.endsWith('.root') ? 'setup' : 'reader';
    state.connections.push({ kind, options });
    return { execute: (options, params) => answer(kind, 'execute', options, params),
      query: (options, params) => answer(kind, 'query', options, params),
      async end() { state.closed.push(kind); }, destroy() { state.destroyed.push(kind); } };
  };
  return { state, run: (options = {}) => setupTiDbTestPortal({ env: environment(), createConnection, fileStore,
    privateEnvPath: privatePath, reportPath, ...options }) };
}

function mutations(state) { return state.calls.filter(call => !/^\s*(?:SELECT|SHOW)\b/i.test(call.sql)); }
function privateValues(text) {
  return Object.fromEntries(text.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
  }));
}

test('default plan inspects the target and privileges without mutations, reader connection or private file', async () => {
  const f = fixture();
  const report = await f.run();
  assert.equal(report.passed, true);
  assert.equal(report.mode, 'plan');
  assert.equal(report.changesApplied, false);
  assert.equal(report.warning, 'NOT FOR PRODUCTION');
  assert.equal(report.plan.totalTablesIncludingMarker, 11);
  assert.equal(report.preflight.existingTablesOrViews, 0);
  assert.deepEqual(mutations(f.state), []);
  assert.deepEqual(report.attemptedOperations, []);
  assert.deepEqual(report.completedOperations, []);
  assert.equal(f.state.writes.length, 0);
  assert.deepEqual(f.state.connections.map(item => item.kind), ['setup']);
  assert.deepEqual(f.state.closed, ['setup']);
  assert.equal(f.state.calls.some(call => call.sql.includes('information_schema.TABLES')), true);
  assert.equal(f.state.calls.some(call => call.sql === 'SHOW GRANTS FOR CURRENT_USER()'), true);
  assert.equal(f.state.reports.length, 1);
  assert.equal(f.state.reports[0].file, reportPath);
  assert.doesNotMatch(f.state.reports[0].text, /Synthetic-setup-password|IDENTIFIED BY/);
});

test('wrong configured or selected database and existing tables or views prevent all DDL', async () => {
  const invalidConfig = fixture();
  const wrongName = await invalidConfig.run({ apply: true, env: environment({ TIDB_SETUP_DATABASE: 'tolanhr' }) });
  assert.equal(wrongName.failure.code, 'TIDB_SETUP_INPUT_INVALID');
  assert.equal(invalidConfig.state.connections.length, 0);
  for (const overrides of [{ selectedDatabase: 'test' },
    { tables: [{ TABLE_NAME: 'existing_data', TABLE_TYPE: 'BASE TABLE' }] },
    { tables: [{ TABLE_NAME: 'existing_view', TABLE_TYPE: 'VIEW' }] }]) {
    const f = fixture(overrides);
    const report = await f.run({ apply: true });
    assert.equal(report.passed, false);
    assert.ok(['TIDB_SETUP_TARGET_MISMATCH', 'TIDB_SETUP_SCHEMA_NOT_EMPTY'].includes(report.failure.code));
    assert.equal(report.changesApplied, false);
    assert.deepEqual(mutations(f.state), []);
    assert.equal(f.state.writes.length, 0);
  }
});

test('existing private credentials and an exclusive-write collision preserve files and prevent all DDL', async () => {
  const existingText = 'Synthetic pre-existing file must remain unchanged';
  const existing = fixture({ files: new Map([[privatePath, existingText]]) });
  const report = await existing.run({ apply: true });
  assert.equal(report.failure.code, 'TIDB_SETUP_PRIVATE_ENV_EXISTS');
  assert.equal(existing.state.connections.length, 0);
  assert.equal(existing.state.files.get(privatePath), existingText);
  assert.equal(existing.state.writes.length, 0);
  const racing = fixture({ failExclusive: true });
  const collision = await racing.run({ apply: true });
  assert.equal(collision.failure.stage, 'reserve-private-credentials');
  assert.equal(collision.failure.code, 'EEXIST');
  assert.deepEqual(mutations(racing.state), []);
  assert.deepEqual(collision.attemptedOperations, []);
});

test('missing setup privileges or grant option fail before private reservation and SQL mutations', async () => {
  for (const overrides of [{ setupPrivileges: ['SELECT', 'INSERT', 'CREATE'] },
    { setupPrivileges: ['SELECT', 'CREATE', 'CREATE USER'] }, { grantOption: false }]) {
    const f = fixture(overrides);
    const report = await f.run({ apply: true });
    assert.equal(report.passed, false);
    assert.equal(report.failure.code, 'TIDB_SETUP_PRIVILEGES_INSUFFICIENT');
    assert.equal(f.state.writes.length, 0);
    assert.deepEqual(mutations(f.state), []);
    assert.deepEqual(f.state.closed, ['setup']);
  }
});

test('a partial DDL failure stops further operations, retains recovery credentials and redacts its public report', async () => {
  let attempts = 0;
  const secret = environment().TIDB_SETUP_PASSWORD;
  const f = fixture({ failSql: sql => /^CREATE TABLE\b/.test(sql) && ++attempts === 3,
    failureMessage: `private SQL host=fixture.invalid password=${secret} CREATE USER secret` });
  const report = await f.run({ apply: true });
  assert.equal(report.passed, false);
  assert.equal(report.failure.stage, 'apply-synthetic-fixture');
  assert.equal(report.failure.code, 'ER_TEST_DDL');
  assert.equal(report.partialSetupPossible, true);
  assert.equal(report.changesApplied, true);
  assert.equal(report.attemptedOperations.length, 3);
  assert.equal(report.completedOperations.length, 3); // Private reservation plus two completed DDL statements.
  assert.equal(report.failedOperation, report.attemptedOperations[2]);
  assert.equal(mutations(f.state).length, 3);
  assert.equal(f.state.calls.some(call => /^CREATE USER|^GRANT|^DROP|^ALTER|^REVOKE/i.test(call.sql)), false);
  assert.equal(f.state.files.has(privatePath), true);
  assert.deepEqual(f.state.closed, ['setup']);
  const credentials = privateValues(f.state.files.get(privatePath));
  const publicText = JSON.stringify(report) + f.state.reports[0].text;
  for (const value of [secret, credentials.BIOMETRIC_TEST_DB_PASSWORD, credentials.BIOMETRIC_TEST_DB_USER,
    'private SQL', 'CREATE USER secret']) assert.equal(publicText.includes(value), false);
  assert.equal(report.cleanup.setupConnectionClosed, true);
});

test('apply reserves credentials before DDL, creates only the fixture and grants eleven named table reads', async () => {
  const f = fixture();
  const report = await f.run({ apply: true });
  assert.equal(report.passed, true, JSON.stringify(report.failure));
  assert.equal(report.mode, 'apply');
  assert.equal(report.partialSetupPossible, false);
  assert.equal(report.readerVerified, true);
  assert.equal(report.fixtureVerified, true);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.writes[0].file, privatePath);
  assert.ok(f.state.calls.slice(0, f.state.writes[0].callCount).every(call => /^(?:SELECT|SHOW)\b/.test(call.sql)));
  const sqlWrites = mutations(f.state);
  assert.equal(sqlWrites.filter(call => /^CREATE TABLE\b/.test(call.sql)).length, 11);
  assert.equal(sqlWrites.filter(call => /^INSERT\b/.test(call.sql)).length, 4);
  assert.equal(sqlWrites.filter(call => /^CREATE USER\b/.test(call.sql)).length, 1);
  const grants = sqlWrites.filter(call => /^GRANT\b/.test(call.sql));
  assert.equal(grants.length, 11);
  const credentials = privateValues(f.state.files.get(privatePath));
  const reader = credentials.BIOMETRIC_TEST_DB_USER;
  assert.match(reader, new RegExp(`^${userPrefix}\\.fp_ro_[0-9a-f]{8}$`));
  assert.ok(reader.length <= 32);
  assert.equal(credentials.BIOMETRIC_TEST_DB_NAME, 'fingerprint');
  assert.equal(credentials.BIOMETRIC_TEST_DB_CONFIRMED_NAME, 'fingerprint');
  assert.equal(credentials.BIOMETRIC_TEST_DB_SSL_MODE, 'required');
  assert.equal(credentials.BIOMETRIC_TEST_DB_INSTANCE_ID, f.state.marker.instance_id);
  assert.match(credentials.BIOMETRIC_TEST_DB_INSTANCE_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(grants.map(call => /^GRANT SELECT ON `fingerprint`\.`([^`]+)` TO /.exec(call.sql)?.[1]).sort(), expectedTables.slice().sort());
  assert.ok(grants.every(call => call.sql.endsWith(`TO '${reader}'@'%'`)));
  assert.ok(sqlWrites.every(call => !/\b(?:DROP|ALTER|REVOKE|DELETE|UPDATE)\b/.test(call.sql)));
  assert.equal(report.attemptedOperations.length, 27);
  assert.equal(report.completedOperations.length, 28);
  assert.deepEqual(f.state.connections.map(item => item.kind), ['setup', 'reader']);
  for (const { options } of f.state.connections) {
    assert.equal(options.database, 'fingerprint');
    assert.deepEqual(options.ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true });
    assert.equal(options.multipleStatements, false);
  }
  assert.equal(f.state.connections[1].options.user, reader);
  assert.equal(f.state.connections[1].options.password, credentials.BIOMETRIC_TEST_DB_PASSWORD);
  assert.deepEqual(f.state.closed, ['reader', 'setup']);
  const publicText = JSON.stringify(report) + f.state.reports[0].text;
  for (const value of [environment().TIDB_SETUP_PASSWORD, credentials.BIOMETRIC_TEST_DB_PASSWORD, reader]) {
    assert.equal(publicText.includes(value), false);
  }
});

test('reader verification accepts case-insensitive SELECT with bare and mixed quoted identifiers', async () => {
  for (const readerGrantTransform of [
    sql => sql.replace(/^GRANT SELECT ON `fingerprint`\.`([^`]+)`/, 'GRANT Select ON fingerprint.$1'),
    (sql, index) => index % 2
      ? sql.replace(/^GRANT SELECT ON `fingerprint`\.`([^`]+)`/, 'GRANT Select ON `fingerprint`.$1')
      : sql.replace(/^GRANT SELECT ON `fingerprint`/, 'GRANT SELECT ON fingerprint')
  ]) {
    const f = fixture({ readerGrantTransform });
    const report = await f.run({ apply: true });
    assert.equal(report.passed, true, JSON.stringify(report.failure));
    assert.equal(report.readerVerified, true);
  }
});

test('reader verification rejects another schema or GRANT OPTION after setup and preserves recovery facts', async () => {
  for (const readerGrantTransform of [
    (sql, index) => index === 0 ? sql.replace('`fingerprint`.', 'other_schema.') : sql,
    (sql, index) => index === 0 ? sql + ' WITH GRANT OPTION' : sql
  ]) {
    const f = fixture({ readerGrantTransform });
    const report = await f.run({ apply: true });
    assert.equal(report.passed, false);
    assert.equal(report.failure.stage, 'verify-reader-account');
    assert.equal(report.failure.code, 'TIDB_SETUP_READER_GRANTS_INVALID');
    assert.equal(report.partialSetupPossible, true);
    assert.equal(report.attemptedOperations.length, 27);
    assert.equal(f.state.files.has(privatePath), true);
    assert.deepEqual(f.state.closed, ['reader', 'setup']);
    assert.equal(f.state.calls.some(call => /^DROP|^ALTER|^REVOKE/i.test(call.sql)), false);
  }
});
