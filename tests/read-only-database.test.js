import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createReadOnlyDatabase } from '../src/infrastructure/database/read-only-database.js';
import { BIOMETRIC_TABLES, REQUIRED_BIOMETRIC_COLUMNS, REQUIRED_BIOMETRIC_UNIQUE_INDEXES } from '../src/infrastructure/storage/biometric-table-names.js';

const database = 'biometric_portal_test_case';
const instanceId = '30eb4402-70cf-45e1-a1b8-ed03a8aef7ce';
const markerTable = 'biometric_portal_test_identity';
const config = { host: 'database.test.invalid', port: 4000, user: 'readonly-test', password: 'test-only-password',
  database, instanceId, sslMode: 'required', connectTimeoutMs: 100, queryTimeoutMs: 100 };

function grantsFor(account = "'readonly-test'@'%'", schema = database) {
  return [`GRANT USAGE ON *.* TO ${account}`,
    ...[...Object.values(BIOMETRIC_TABLES), markerTable].map(table => `GRANT SELECT ON \`${schema}\`.\`${table}\` TO ${account}`)]
    .map(value => ({ 'Grants for current user': value }));
}

function fixture(overrides = {}) {
  const state = { currentDatabase: database, role: 'NONE', grants: grantsFor(), markers: [{ purpose: 'portal-isolated-test-v1', instance_id: instanceId }],
    calls: [], poolOptions: null, acquired: 0, released: 0, destroyed: 0, ended: 0, ...overrides };
  async function answer(options, params = []) {
    state.calls.push({ sql: options.sql, timeout: options.timeout, params });
    const sql = options.sql;
    if (state.failMessage) throw Object.assign(new Error(state.failMessage), { code: 'ER_TEST_FAILURE' });
    if (sql.includes('SELECT DATABASE()')) return [[{ current_database: state.currentDatabase }], []];
    if (sql === 'SELECT CURRENT_ROLE() AS active_roles') return [[{ active_roles: state.role }], []];
    if (sql.startsWith('SHOW GRANTS')) return [state.grants, []];
    if (sql.includes('information_schema.COLUMNS')) return [Object.entries(REQUIRED_BIOMETRIC_COLUMNS)
      .flatMap(([table, columns]) => columns.filter(column => !(state.omitColumn && table === BIOMETRIC_TABLES.devices && column === 'vendor'))
        .map(column => ({ TABLE_NAME: table, COLUMN_NAME: column }))), []];
    if (sql.includes('information_schema.TABLES')) return [Object.values(BIOMETRIC_TABLES)
      .map(table => ({ TABLE_NAME: table, TABLE_COLLATION: state.badCollation ? 'utf8mb4_unicode_ci' : 'utf8mb4_bin' })), []];
    if (sql.includes('information_schema.STATISTICS')) return [Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES)
      .flatMap(([table, indexes]) => Object.entries(indexes).flatMap(([name, columns]) => columns.map((column, index) =>
        ({ TABLE_NAME: table, INDEX_NAME: name, NON_UNIQUE: 0, SEQ_IN_INDEX: index + 1, COLUMN_NAME: column })))), []];
    if (sql.includes(markerTable)) return [state.markers, []];
    if (state.hangQuery && sql === 'SELECT 7 AS value') return new Promise(() => {});
    return [[{ value: 7 }], []];
  }
  function createPool(options) {
    state.poolOptions = options;
    return {
      async getConnection() {
        state.acquired++;
        if (state.acquireWait) await state.acquireWait;
        return { execute: answer, query: answer, release() { state.released++; }, destroy() { state.destroyed++; } };
      },
      async end() { state.ended++; if (state.hangEnd) await new Promise(() => {}); }
    };
  }
  return { state, createPool };
}

test('isolated database validates the schema and grants before exposing a frozen narrow read interface', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase(config, { createPool: f.createPool });
  assert.equal(Object.isFrozen(db), true);
  assert.deepEqual(Object.keys(db).sort(), ['checkReady', 'end', 'execute']);
  assert.equal(f.state.calls.some(call => call.sql.includes('information_schema.COLUMNS')), true);
  assert.equal(f.state.calls.some(call => call.sql === 'SHOW GRANTS FOR CURRENT_USER()'), true);
  assert.equal(f.state.calls.some(call => call.sql === 'SELECT CURRENT_ROLE() AS active_roles'), true);
  assert.deepEqual(await db.execute('SELECT 7 AS value'), [[{ value: 7 }], []]);
  assert.deepEqual(await db.checkReady(), { ready: true });
  await db.end(); await db.end();
  assert.equal(f.state.ended, 1);
  assert.equal(f.state.acquired, f.state.released);
});

test('pool settings bound connections and timeouts and preserve verified TLS and exact database values', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase(config, { createPool: f.createPool });
  assert.deepEqual(f.state.poolOptions.ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true });
  assert.equal(f.state.poolOptions.connectTimeout, 100);
  assert.equal(f.state.poolOptions.connectionLimit, 3);
  assert.equal(f.state.poolOptions.queueLimit, 10);
  assert.equal(f.state.poolOptions.multipleStatements, false);
  assert.equal(f.state.poolOptions.bigNumberStrings, true);
  assert.equal(f.state.poolOptions.dateStrings, true);
  assert.equal(f.state.poolOptions.database, database);
  assert.equal(f.state.calls.every(call => call.timeout === 100), true);
  await db.end();
});

test('dedicated test config is mandatory and remote TLS cannot be disabled', async () => {
  let created = 0;
  const createPool = () => { created++; throw new Error('must not be called'); };
  for (const change of [{ database: 'production' }, { database: 'biometric_portal_test_' }, { instanceId: 'not-a-uuid' },
    { host: '' }, { user: '' }, { password: '' }, { sslMode: 'disabled' }, { port: '4000' }, { port: 0 },
    { connectionLimit: 0 }, { queryTimeoutMs: Infinity }, { connectTimeoutMs: -1 }]) {
    await assert.rejects(createReadOnlyDatabase({ ...config, ...change }, { createPool }), { code: 'READ_ONLY_DATABASE_CONFIG_INVALID' });
  }
  assert.equal(created, 0);
});

test('fingerprint needs exact confirmation before opening a pool and retains marker and grant checks', async () => {
  let opened = 0;
  const shouldNotOpen = () => { opened++; throw new Error('must not open an unconfirmed database'); };
  for (const confirmedName of [undefined, '', 'Fingerprint', ' fingerprint', 'fingerprint ', 'test', true]) {
    await assert.rejects(createReadOnlyDatabase({ ...config, database: 'fingerprint', confirmedName },
      { createPool: shouldNotOpen }), { code: 'READ_ONLY_DATABASE_CONFIG_INVALID' });
  }
  for (const name of ['test', 'tolanhr', 'production', 'Fingerprint', 'fingerprint_other']) {
    await assert.rejects(createReadOnlyDatabase({ ...config, database: name, confirmedName: name },
      { createPool: shouldNotOpen }), { code: 'READ_ONLY_DATABASE_CONFIG_INVALID' });
  }
  assert.equal(opened, 0);
  const confirmed = { ...config, database: 'fingerprint', confirmedName: 'fingerprint' };
  const f = fixture({ currentDatabase: 'fingerprint', grants: grantsFor("'readonly-test'@'%'", 'fingerprint') });
  const db = await createReadOnlyDatabase(confirmed, { createPool: f.createPool });
  assert.equal(f.state.poolOptions.database, 'fingerprint');
  assert.deepEqual(await db.checkReady(), { ready: true });
  await db.end();
  for (const overrides of [{ markers: [] }, { grants: grantsFor() }, { currentDatabase: database }]) {
    const rejected = fixture({ currentDatabase: 'fingerprint', grants: grantsFor("'readonly-test'@'%'", 'fingerprint'), ...overrides });
    await assert.rejects(createReadOnlyDatabase(confirmed, { createPool: rejected.createPool }), error =>
      ['READ_ONLY_DATABASE_IDENTITY_REJECTED', 'READ_ONLY_DATABASE_GRANTS_REJECTED'].includes(error.code));
    assert.equal(rejected.state.ended, 1);
  }
});

test('loopback-only test databases may explicitly omit TLS', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase({ ...config, host: '127.0.0.1', sslMode: 'disabled' }, { createPool: f.createPool });
  assert.equal(f.state.poolOptions.ssl, undefined);
  await db.end();
});

test('account quoting and exact literal underscore database names work for table-level grants', async () => {
  for (const account of ["'readonly-test'@'localhost'", '`readonly-test`@`%`']) {
    const f = fixture({ grants: grantsFor(account) });
    const db = await createReadOnlyDatabase(config, { createPool: f.createPool });
    await db.end();
  }
});

test('schema-wide, global, writable, role, proxy and grant-option privileges are rejected and close the pool', async () => {
  const account = "'readonly-test'@'%'";
  const badGrants = [
    `GRANT SELECT ON *.* TO ${account}`,
    `GRANT SELECT ON \`${database}\`.* TO ${account}`,
    `GRANT SELECT ON \`biometric\\_portal\\_test\\_case\`.* TO ${account}`,
    `GRANT SELECT, INSERT ON \`${database}\`.\`${markerTable}\` TO ${account}`,
    `GRANT ALL PRIVILEGES ON *.* TO ${account}`,
    `GRANT \`reader\`@\`%\` TO ${account}`,
    `GRANT PROXY ON 'other'@'%' TO ${account}`,
    `GRANT SELECT ON \`${database}\`.\`${markerTable}\` TO ${account} WITH GRANT OPTION`,
    `GRANT SELECT ON \`other_database\`.\`${markerTable}\` TO ${account}`,
    `GRANT SELECT ON \`${database}\`.\`unrelated_table\` TO ${account}`,
    `GRANT SELECT (purpose) ON \`${database}\`.\`${markerTable}\` TO ${account}`,
  ];
  for (const value of badGrants) {
    const f = fixture({ grants: [...grantsFor(), { grant: value }] });
    await assert.rejects(createReadOnlyDatabase(config, { createPool: f.createPool }), { code: 'READ_ONLY_DATABASE_GRANTS_REJECTED' });
    assert.equal(f.state.ended, 1);
  }
});

test('missing table grants and active roles fail closed without querying the marker', async () => {
  for (const overrides of [{ grants: grantsFor().slice(0, -1) }, { role: '`mandatory-reader`@`%`' }, { role: null }]) {
    const f = fixture(overrides);
    await assert.rejects(createReadOnlyDatabase(config, { createPool: f.createPool }), { code: 'READ_ONLY_DATABASE_GRANTS_REJECTED' });
    assert.equal(f.state.ended, 1);
    assert.equal(f.state.calls.some(call => call.sql.includes(`FROM \`${markerTable}\``)), false);
  }
});

test('wrong database, missing or ambiguous markers, wrong purpose and wrong instance all fail closed', async () => {
  for (const overrides of [{ currentDatabase: 'production' }, { markers: [] }, { markers: [{ purpose: 'production', instance_id: instanceId }] },
    { markers: [{ purpose: 'portal-isolated-test-v1', instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] },
    { markers: [{ purpose: 'portal-isolated-test-v1', instance_id: instanceId }, { purpose: 'portal-isolated-test-v1', instance_id: instanceId }] }]) {
    const f = fixture(overrides);
    await assert.rejects(createReadOnlyDatabase(config, { createPool: f.createPool }), { code: 'READ_ONLY_DATABASE_IDENTITY_REJECTED' });
    assert.equal(f.state.ended, 1);
  }
});

test('schema incompatibility closes the pool and does not expose raw schema details', async () => {
  for (const overrides of [{ omitColumn: true }, { badCollation: true }]) {
    const f = fixture(overrides);
    await assert.rejects(createReadOnlyDatabase(config, { createPool: f.createPool }), error => {
      assert.equal(error.code, 'READ_ONLY_DATABASE_SCHEMA_REJECTED');
      assert.doesNotMatch(error.message, /vendor|collation|biometric_svc/);
      return true;
    });
    assert.equal(f.state.ended, 1);
  }
});

test('only bounded SELECT queries reach the driver and search data stays in prepared parameters', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase(config, { createPool: f.createPool });
  const acquiredBefore = f.state.acquired;
  for (const query of ['INSERT INTO x VALUES (1)', 'DELETE FROM x', 'UPDATE x SET a=1', 'SHOW GRANTS',
    'SELECT 1; DELETE FROM x', 'SELECT 1;', 'SELECT /* hint */ 1', 'SELECT 1 -- hi', 'SELECT 1 # hi',
    "SELECT 1 INTO OUTFILE '/tmp/x'", 'SELECT * FROM x FOR UPDATE', 'SELECT * FROM x FOR SHARE',
    'SELECT * FROM x LOCK IN SHARE MODE', "SELECT LOAD_FILE('/x')", "SELECT GET_LOCK('x', 10)",
    'SELECT SLEEP(99)', 'SELECT BENCHMARK(99,1)', 'SELECT @x := 1', 'SELECT 1\0']) {
    await assert.rejects(db.execute(query), { code: 'READ_ONLY_DATABASE_QUERY_REJECTED' });
  }
  await assert.rejects(db.execute('SELECT 1', 'not-an-array'), { code: 'READ_ONLY_DATABASE_QUERY_REJECTED' });
  assert.equal(f.state.acquired, acquiredBefore);
  const params = ["%; DELETE FROM private_table; --"];
  await db.execute('SELECT 7 AS value WHERE ? IS NOT NULL', params);
  assert.equal(f.state.calls.at(-1).sql, 'SELECT 7 AS value WHERE ? IS NOT NULL');
  assert.equal(f.state.calls.at(-1).params, params);
  await db.end();
});

test('runtime driver errors are sanitized, discard their connection and allow later recovery', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase(config, { createPool: f.createPool });
  f.state.failMessage = 'private host user password SQL query error';
  await assert.rejects(db.execute('SELECT 7 AS value'), error => {
    assert.equal(error.code, 'READ_ONLY_DATABASE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(error), /private|host|password|query error/);
    assert.doesNotMatch(error.message, /private|password/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(f.state.destroyed, 1);
  assert.equal(f.state.ended, 0);
  f.state.failMessage = null;
  assert.deepEqual(await db.checkReady(), { ready: true });
  await db.end();
});

test('query timeout destroys its connection, returns a bounded safe error and permits a fresh read', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase({ ...config, queryTimeoutMs: 20 }, { createPool: f.createPool });
  f.state.hangQuery = true;
  await assert.rejects(db.execute('SELECT 7 AS value'), { code: 'READ_ONLY_DATABASE_TIMEOUT' });
  assert.equal(f.state.destroyed, 1);
  f.state.hangQuery = false;
  assert.deepEqual(await db.execute('SELECT 7 AS value'), [[{ value: 7 }], []]);
  await db.end();
});

test('pool acquisition has its own deadline and a late connection is released', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase({ ...config, connectTimeoutMs: 20 }, { createPool: f.createPool });
  let releaseAcquire;
  f.state.acquireWait = new Promise(resolve => { releaseAcquire = resolve; });
  const before = f.state.released;
  await assert.rejects(db.execute('SELECT 7 AS value'), { code: 'READ_ONLY_DATABASE_TIMEOUT' });
  releaseAcquire();
  await delay(0);
  assert.equal(f.state.released, before + 1);
  await db.end();
});

test('checkReady rechecks grants and identity after startup and permanently closes on a mismatch', async () => {
  for (const field of ['markers', 'grants']) {
    const f = fixture();
    const db = await createReadOnlyDatabase(config, { createPool: f.createPool });
    f.state[field] = [];
    await assert.rejects(db.checkReady(), { code: field === 'markers' ? 'READ_ONLY_DATABASE_IDENTITY_REJECTED' : 'READ_ONLY_DATABASE_GRANTS_REJECTED' });
    await assert.rejects(db.execute('SELECT 7 AS value'), { code: 'READ_ONLY_DATABASE_CLOSED' });
    assert.equal(f.state.ended, 1);
  }
});

test('end cancels pending operations, destroys active connections and prevents future reads', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase(config, { createPool: f.createPool });
  f.state.hangQuery = true;
  const pending = assert.rejects(db.execute('SELECT 7 AS value'), { code: 'READ_ONLY_DATABASE_CLOSED' });
  await delay(0);
  await db.end(); await pending;
  assert.equal(f.state.destroyed, 1);
  await assert.rejects(db.checkReady(), { code: 'READ_ONLY_DATABASE_CLOSED' });
});

test('pool close failure and timeout are bounded and sanitized', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase({ ...config, connectTimeoutMs: 20 }, { createPool: f.createPool });
  f.state.hangEnd = true;
  await assert.rejects(db.end(), { code: 'READ_ONLY_DATABASE_CLOSE_TIMEOUT' });
  await assert.rejects(db.execute('SELECT 7 AS value'), { code: 'READ_ONLY_DATABASE_CLOSED' });
});

function standaloneConfig(overrides = {}) {
  const { instanceId: _fixtureIdentity, ...connection } = config;
  return { ...connection, profile: 'standalone-readonly', database: 'fingerprint', confirmedName: 'fingerprint', ...overrides };
}

function standaloneFixture(overrides = {}) {
  return fixture({ currentDatabase: 'fingerprint', markers: null,
    grants: grantsFor("'fingerprint-reader'@'%'", 'fingerprint').filter(row => !Object.values(row)[0].includes(markerTable)),
    ...overrides });
}

test('standalone profile opens the copied ten-table fingerprint schema without an instance ID or marker query', async () => {
  const f = standaloneFixture();
  const db = await createReadOnlyDatabase(standaloneConfig(), { createPool: f.createPool });
  assert.equal(f.state.poolOptions.database, 'fingerprint');
  assert.deepEqual(f.state.poolOptions.ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true });
  assert.deepEqual(await db.execute('SELECT 7 AS value'), [[{ value: 7 }], []]);
  assert.deepEqual(await db.checkReady(), { ready: true });
  assert.equal(f.state.calls.filter(call => call.sql.includes('information_schema.COLUMNS')).length, 2);
  assert.equal(f.state.calls.some(call => call.sql.includes(markerTable) || call.params.includes(markerTable)), false);
  const before = f.state.acquired;
  await assert.rejects(db.execute('UPDATE biometric_svc_people SET status = ?', ['inactive']), { code: 'READ_ONLY_DATABASE_QUERY_REJECTED' });
  assert.equal(f.state.acquired, before);
  await db.end();
  await assert.rejects(db.checkReady(), { code: 'READ_ONLY_DATABASE_CLOSED' });
  assert.equal(f.state.ended, 1);
});

test('standalone mode needs its exact explicit profile and fingerprint confirmation before opening any pool', async () => {
  let opened = 0;
  const createPool = () => { opened++; throw new Error('must not open'); };
  for (const profile of [null, '', false, 0, 'production', 'standalone', 'Standalone-readonly', 'standalone-readonly ']) {
    await assert.rejects(createReadOnlyDatabase(standaloneConfig({ profile }), { createPool }), { code: 'READ_ONLY_DATABASE_CONFIG_INVALID' });
  }
  for (const database of ['test', 'biometric_portal_test_case', 'Fingerprint', 'fingerprint_other', 'fingerprint ']) {
    await assert.rejects(createReadOnlyDatabase(standaloneConfig({ database, confirmedName: database }), { createPool }), { code: 'READ_ONLY_DATABASE_CONFIG_INVALID' });
  }
  for (const confirmedName of [undefined, '', 'test', 'Fingerprint', 'fingerprint ']) {
    await assert.rejects(createReadOnlyDatabase(standaloneConfig({ confirmedName }), { createPool }), { code: 'READ_ONLY_DATABASE_CONFIG_INVALID' });
  }
  await assert.rejects(createReadOnlyDatabase(standaloneConfig({ sslMode: 'disabled' }), { createPool }), { code: 'READ_ONLY_DATABASE_CONFIG_INVALID' });
  assert.equal(opened, 0);
});

test('explicit fixture profile preserves its UUID and marker checks rather than inheriting standalone behavior', async () => {
  const f = fixture();
  const db = await createReadOnlyDatabase({ ...config, profile: 'fixture-readonly' }, { createPool: f.createPool });
  assert.equal(f.state.calls.some(call => call.sql.includes(`FROM \`${markerTable}\``)), true);
  await db.end();
  const missing = fixture();
  await assert.rejects(createReadOnlyDatabase({ ...config, profile: 'fixture-readonly', instanceId: undefined },
    { createPool: missing.createPool }), { code: 'READ_ONLY_DATABASE_CONFIG_INVALID' });
  assert.equal(missing.state.acquired, 0);
});

test('standalone guard rejects root, global, schema, write, role, proxy and marker grants with no marker access', async () => {
  const account = "'fingerprint-reader'@'%'";
  const rejected = [
    `GRANT ALL PRIVILEGES ON *.* TO 'prefix.root'@'%' WITH GRANT OPTION`,
    `GRANT SELECT ON *.* TO ${account}`,
    `GRANT SELECT ON fingerprint.* TO ${account}`,
    `GRANT SELECT, INSERT ON fingerprint.biometric_svc_people TO ${account}`,
    `GRANT UPDATE ON fingerprint.biometric_svc_people TO ${account}`,
    `GRANT DELETE ON fingerprint.biometric_svc_people TO ${account}`,
    `GRANT SELECT ON fingerprint.biometric_svc_people TO ${account} WITH GRANT OPTION`,
    `GRANT SELECT ON test.biometric_svc_people TO ${account}`,
    `GRANT SELECT ON fingerprint.${markerTable} TO ${account}`,
    `GRANT \`reader_role\`@\`%\` TO ${account}`,
    `GRANT PROXY ON 'another'@'%' TO ${account}`,
  ];
  for (const text of rejected) {
    const f = standaloneFixture();
    f.state.grants.push({ grant: text });
    await assert.rejects(createReadOnlyDatabase(standaloneConfig(), { createPool: f.createPool }), error => {
      assert.equal(error.code, 'READ_ONLY_DATABASE_GRANTS_REJECTED');
      assert.doesNotMatch(error.message, /prefix|fingerprint-reader|GRANT/);
      return true;
    });
    assert.equal(f.state.ended, 1);
    assert.equal(f.state.calls.some(call => call.sql.includes(`FROM \`${markerTable}\``)), false);
  }
});

test('standalone startup refuses a missing table grant, active role, different selected database or incompatible schema', async () => {
  const scenarios = [
    { overrides: { grants: standaloneFixture().state.grants.slice(0, -1) }, code: 'READ_ONLY_DATABASE_GRANTS_REJECTED' },
    { overrides: { role: '`mandatory_reader`@`%`' }, code: 'READ_ONLY_DATABASE_GRANTS_REJECTED' },
    { overrides: { currentDatabase: 'test' }, code: 'READ_ONLY_DATABASE_IDENTITY_REJECTED' },
    { overrides: { omitColumn: true }, code: 'READ_ONLY_DATABASE_SCHEMA_REJECTED' },
  ];
  for (const scenario of scenarios) {
    const f = standaloneFixture(scenario.overrides);
    await assert.rejects(createReadOnlyDatabase(standaloneConfig(), { createPool: f.createPool }), { code: scenario.code });
    assert.equal(f.state.ended, 1);
    assert.equal(f.state.calls.some(call => call.sql.includes(`FROM \`${markerTable}\``)), false);
  }
});

test('standalone readiness revalidates schema and allows recovery from a temporary schema failure', async () => {
  const f = standaloneFixture();
  const db = await createReadOnlyDatabase(standaloneConfig(), { createPool: f.createPool });
  f.state.omitColumn = true;
  await assert.rejects(db.checkReady(), { code: 'READ_ONLY_DATABASE_SCHEMA_REJECTED' });
  assert.equal(f.state.ended, 0);
  f.state.omitColumn = false;
  assert.deepEqual(await db.checkReady(), { ready: true });
  f.state.role = '`unexpected_role`@`%`';
  await assert.rejects(db.checkReady(), { code: 'READ_ONLY_DATABASE_GRANTS_REJECTED' });
  assert.equal(f.state.ended, 1);
  await assert.rejects(db.execute('SELECT 7 AS value'), { code: 'READ_ONLY_DATABASE_CLOSED' });
});
