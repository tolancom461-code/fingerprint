import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStandaloneReader } from '../scripts/prepare-standalone-reader.mjs';
import { BIOMETRIC_TABLES, REQUIRED_BIOMETRIC_COLUMNS, REQUIRED_BIOMETRIC_UNIQUE_INDEXES } from '../src/infrastructure/storage/biometric-table-names.js';

const tables = Object.values(BIOMETRIC_TABLES);
const privatePath = '/synthetic/private/portal.env';
const reportPath = '/synthetic/public/reader-report.json';
const prefix = 'Ab12Cd34Ef56Gh78';
const env = { TIDB_SETUP_HOST: 'synthetic.invalid', TIDB_SETUP_PORT: '4000', TIDB_SETUP_USER: `${prefix}.root`,
  TIDB_SETUP_PASSWORD: 'Synthetic-setup-secret!2026', TIDB_SETUP_DATABASE: 'fingerprint' };

function fixture(overrides = {}) {
  const state = { calls: [], opened: [], verified: [], files: new Map(), writes: [], reports: [],
    tableSet: tables.map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: 'BASE TABLE' })), selected: 'fingerprint',
    privileges: ['SELECT', 'CREATE USER'], grantOption: true, closed: 0, destroyed: 0, ...overrides };
  const files = {
    async exists(file) { return state.files.has(file); },
    async writeExclusive(file, text) {
      state.writes.push({ file, text, atCall: state.calls.length });
      if (state.files.has(file) || state.writeCollision) throw Object.assign(new Error('Synthetic collision'), { code: 'EEXIST' });
      state.files.set(file, text);
    },
    async writeReport(file, text) { state.reports.push({ file, text }); }
  };
  const answer = async (method, options, params = []) => {
    const { sql } = options;
    state.calls.push({ method, sql, params, timeout: options.timeout });
    if (state.rejectSql?.(sql)) throw Object.assign(new Error('Sensitive SQL failure details must not escape'), { code: 'ER_SYNTHETIC_FAILURE' });
    if (sql === 'SELECT DATABASE() AS current_database') return [[{ current_database: state.selected }], []];
    if (sql.includes('TABLE_TYPE')) return [state.tableSet, []];
    if (sql === 'SELECT CURRENT_ROLE() AS active_roles') return [[{ active_roles: 'NONE' }], []];
    if (sql === 'SHOW GRANTS FOR CURRENT_USER()') return [[{ Grant: `GRANT ${state.privileges.join(', ')} ON *.* TO '${prefix}.root'@'%'${state.grantOption ? ' WITH GRANT OPTION' : ''}` }], []];
    if (sql.includes('information_schema.COLUMNS')) return [Object.entries(REQUIRED_BIOMETRIC_COLUMNS)
      .flatMap(([table, columns]) => columns.map(column => ({ TABLE_NAME: table, COLUMN_NAME: column }))), []];
    if (sql.includes('information_schema.TABLES')) return [tables.map(TABLE_NAME => ({ TABLE_NAME, TABLE_COLLATION: 'utf8mb4_bin' })), []];
    if (sql.includes('information_schema.STATISTICS')) return [Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES)
      .flatMap(([table, indexes]) => Object.entries(indexes).flatMap(([index, columns]) => columns.map((column, sequence) =>
        ({ TABLE_NAME: table, INDEX_NAME: index, NON_UNIQUE: 0, SEQ_IN_INDEX: sequence + 1, COLUMN_NAME: column })))), []];
    if (/^CREATE USER\b|^GRANT SELECT\b/.test(sql)) return [{ affectedRows: 0 }, []];
    throw new Error('Unexpected synthetic statement');
  };
  const createConnection = async options => {
    state.opened.push(options);
    return { execute: (options, params) => answer('execute', options, params), query: (options, params) => answer('query', options, params),
      async end() { state.closed++; }, destroy() { state.destroyed++; } };
  };
  const verifyReader = async settings => {
    state.verified.push(settings);
    if (state.failVerify) throw Object.assign(new Error('Private reader connection details'), { code: 'READ_ONLY_DATABASE_GRANTS_REJECTED' });
  };
  return { state, run: options => prepareStandaloneReader({ env, createConnection, verifyReader, fileStore: files,
    privateEnvPath: privatePath, reportPath, ...options }) };
}

function mutations(state) { return state.calls.filter(item => !/^(?:SELECT|SHOW)\b/.test(item.sql)); }
function credentials(text) { return Object.fromEntries(text.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), JSON.parse(line.slice(at + 1))];
})); }

test('default plan verifies the copied ten-table schema and setup ability without account creation or credentials', async () => {
  const f = fixture();
  const report = await f.run();
  assert.equal(report.passed, true);
  assert.equal(report.mode, 'plan');
  assert.equal(report.plan.dataTables, 10);
  assert.equal(report.profile, 'standalone-readonly');
  assert.deepEqual(mutations(f.state), []);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.verified.length, 0);
  assert.equal(f.state.opened.length, 1);
  assert.equal(f.state.closed, 1);
  assert.deepEqual(f.state.opened[0].ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true });
  assert.equal(f.state.opened[0].jsonStrings, true);
  assert.equal(f.state.calls.every(call => call.timeout === 5000), true);
});

test('source settings, test schema and non-root setup accounts are rejected before connecting', async () => {
  for (const override of [{ TIDB_SETUP_DATABASE: 'test' }, { TIDB_SETUP_USER: `${prefix}.old_reader` },
    { TIDB_SOURCE_HOST: 'do-not-connect.invalid' }, { TIDB_SOURCE_PASSWORD: 'Synthetic-source-secret' },
    { TIDB_SETUP_HOST: 'bad/host' }]) {
    const f = fixture();
    const report = await f.run({ apply: true, env: { ...env, ...override } });
    assert.equal(report.passed, false);
    assert.equal(f.state.opened.length, 0);
    assert.equal(f.state.writes.length, 0);
    assert.deepEqual(mutations(f.state), []);
  }
});

test('wrong selected schema, marker, missing tables, views and extra tables prevent provisioning', async () => {
  for (const override of [{ selected: 'test' }, { tableSet: [] },
    { tableSet: [...tables.map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: 'BASE TABLE' })), { TABLE_NAME: 'biometric_portal_test_identity', TABLE_TYPE: 'BASE TABLE' }] },
    { tableSet: tables.map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: TABLE_NAME === tables[0] ? 'VIEW' : 'BASE TABLE' })) },
    { tableSet: [...tables.slice(1).map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: 'BASE TABLE' })), { TABLE_NAME: 'workers', TABLE_TYPE: 'BASE TABLE' }] }]) {
    const f = fixture(override);
    const report = await f.run({ apply: true });
    assert.equal(report.passed, false);
    assert.deepEqual(mutations(f.state), []);
    assert.equal(f.state.writes.length, 0);
  }
});

test('setup must be able to create users and grant SELECT, without requiring table write privileges', async () => {
  for (const override of [{ privileges: ['SELECT'] }, { privileges: ['CREATE USER'] }, { grantOption: false }]) {
    const f = fixture(override);
    const report = await f.run({ apply: true });
    assert.equal(report.failure.code, 'STANDALONE_READER_SETUP_PRIVILEGES_REJECTED');
    assert.deepEqual(mutations(f.state), []);
    assert.equal(f.state.writes.length, 0);
  }
  const minimum = fixture();
  assert.equal((await minimum.run()).passed, true);
});

test('apply reserves new credentials first and creates a distinct reader with exactly ten SELECT grants', async () => {
  const f = fixture();
  const report = await f.run({ apply: true });
  assert.equal(report.passed, true, JSON.stringify(report.failure));
  const values = credentials(f.state.files.get(privatePath));
  const reader = values.BIOMETRIC_PORTAL_DB_USER;
  assert.match(reader, new RegExp(`^${prefix}\\.fp_view_[0-9a-f]{7}$`));
  assert.ok(reader.length <= 32);
  assert.equal(values.BIOMETRIC_PORTAL_DB_NAME, 'fingerprint');
  assert.equal(values.BIOMETRIC_PORTAL_DB_CONFIRMED_NAME, 'fingerprint');
  assert.equal(values.BIOMETRIC_PORTAL_DB_SSL_MODE, 'required');
  assert.equal(Object.keys(values).some(key => key.startsWith('TIDB_SETUP_') || key.startsWith('BIOMETRIC_TEST_') || key.includes('ADMIN')), false);
  assert.equal(f.state.calls.slice(0, f.state.writes[0].atCall).every(call => /^(?:SELECT|SHOW)\b/.test(call.sql)), true);
  const writes = mutations(f.state);
  assert.equal(writes.filter(call => /^CREATE USER\b/.test(call.sql)).length, 1);
  const grants = writes.filter(call => /^GRANT SELECT\b/.test(call.sql));
  assert.equal(grants.length, 10);
  assert.deepEqual(grants.map(call => /ON `fingerprint`\.`([^`]+)`/.exec(call.sql)[1]).sort(), tables.slice().sort());
  assert.equal(writes.every(call => /^CREATE USER\b|^GRANT SELECT\b/.test(call.sql)), true);
  assert.equal(grants.every(call => call.sql.endsWith(`TO '${reader}'@'%'`) && !call.sql.includes('WITH GRANT OPTION')), true);
  assert.equal(f.state.verified.length, 1);
  const runtime = f.state.verified[0];
  assert.equal(runtime.profile, 'standalone-readonly');
  assert.equal(runtime.user, reader);
  assert.equal(runtime.password, values.BIOMETRIC_PORTAL_DB_PASSWORD);
  assert.equal(runtime.user.endsWith('.root'), false);
  assert.equal(runtime.database, 'fingerprint');
  assert.equal(runtime.confirmedName, 'fingerprint');
  assert.equal(Object.hasOwn(runtime, 'instanceId'), false);
  assert.equal(report.readerVerified, true);
  assert.equal(report.dataTablesChanged, false);
  assert.equal(report.partialProvisioningPossible, false);
  assert.equal(report.attemptedOperations.length, 11);
  const output = JSON.stringify(report) + f.state.reports[0].text;
  for (const secret of [env.TIDB_SETUP_PASSWORD, env.TIDB_SETUP_USER, reader, values.BIOMETRIC_PORTAL_DB_PASSWORD]) assert.equal(output.includes(secret), false);
});

test('existing private file and wx collision prevent all account or grant operations', async () => {
  const old = 'Synthetic existing private file';
  const existing = fixture({ files: new Map([[privatePath, old]]) });
  const report = await existing.run({ apply: true });
  assert.equal(report.failure.code, 'STANDALONE_READER_PRIVATE_ENV_EXISTS');
  assert.equal(existing.state.opened.length, 0);
  assert.equal(existing.state.files.get(privatePath), old);
  const racing = fixture({ writeCollision: true });
  const collision = await racing.run({ apply: true });
  assert.equal(collision.failure.code, 'EEXIST');
  assert.deepEqual(mutations(racing.state), []);
  assert.equal(racing.state.verified.length, 0);
});

test('partial grant failure keeps credentials and completion facts without revoking users or changing tables', async () => {
  let grants = 0;
  const f = fixture({ rejectSql: sql => /^GRANT SELECT\b/.test(sql) && ++grants === 3 });
  const report = await f.run({ apply: true });
  assert.equal(report.passed, false);
  assert.equal(report.failure.code, 'ER_SYNTHETIC_FAILURE');
  assert.equal(report.partialProvisioningPossible, true);
  assert.equal(report.privateEnvWritten, true);
  assert.equal(report.attemptedOperations.length, 4);
  assert.equal(report.completedOperations.length, 4); // Reservation, CREATE USER, two SELECT grants.
  assert.equal(report.failedOperation, report.attemptedOperations.at(-1));
  assert.equal(f.state.files.has(privatePath), true);
  assert.equal(f.state.verified.length, 0);
  assert.equal(f.state.calls.some(call => /^(?:DROP|INSERT|DELETE|UPDATE|ALTER|REVOKE)\b/.test(call.sql)), false);
  assert.equal(JSON.stringify(report).includes('Sensitive SQL failure'), false);
});

test('runtime verification failure remains visible with recovery credentials and no automatic account rollback', async () => {
  const f = fixture({ failVerify: true });
  const report = await f.run({ apply: true });
  assert.equal(report.passed, false);
  assert.equal(report.failure.stage, 'verify-runtime-reader');
  assert.equal(report.failure.code, 'READ_ONLY_DATABASE_GRANTS_REJECTED');
  assert.equal(report.failedOperation, null);
  assert.equal(report.partialProvisioningPossible, true);
  assert.equal(report.privateEnvWritten, true);
  assert.equal(f.state.closed, 1);
  assert.equal(report.cleanup.setupConnectionClosed, true);
});
