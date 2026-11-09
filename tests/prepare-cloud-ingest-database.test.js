import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { prepareCloudIngestDatabase } from '../scripts/prepare-cloud-ingest-database.mjs';
import { INGEST_TABLE_PRIVILEGES } from '../src/infrastructure/database/ingest-database.js';
import { BIOMETRIC_TABLES, REQUIRED_BIOMETRIC_COLUMNS, REQUIRED_BIOMETRIC_UNIQUE_INDEXES } from '../src/infrastructure/storage/biometric-table-names.js';
import { serializeRow, canonicalRowsHash } from '../scripts/lib/biometric-backup-format.mjs';
import { ingestSchemaDefinitions } from '../scripts/test-fixtures/standalone-ingest-fixture.mjs';

const names = Object.values(BIOMETRIC_TABLES), processing = BIOMETRIC_TABLES.eventProcessing;
const flag = 'automatic_finalization_eligible';
const privatePath = '/unit/private/writer.env', reportPath = '/unit/public/writer-report.json';
const backupParent = '/unit/backups', backupDirectory = '/unit/backups/cloud-ingest-backup-unit';
const prefix = 'Ab12Cd34Ef56Gh78';
const env = { TIDB_SETUP_HOST: 'synthetic.invalid', TIDB_SETUP_PORT: '4000', TIDB_SETUP_USER: `${prefix}.root`,
  TIDB_SETUP_PASSWORD: 'Synthetic-private-setup-password!2026', TIDB_SETUP_DATABASE: 'fingerprint' };
const withFlag = ddl => ddl.replace(/(\s+PRIMARY KEY)/, '\n  `automatic_finalization_eligible` tinyint(3) unsigned NOT NULL DEFAULT \'0\',$1');
const key = table => table === processing ? 'ingest_event_id' : 'id';

function fixture(options = {}) {
  const state = { calls: [], connections: [], writes: [], reports: [], files: new Map(), exportCalls: 0,
    backupDirectories: 0, verifiedWriters: [], closed: 0, destroyed: 0, columnPresent: false,
    selected: 'fingerprint', privileges: ['SELECT', 'INSERT', 'UPDATE', 'ALTER', 'CREATE USER'], grantOption: true,
    capturedCounter: '1000000', metadataCounter: '1000000',
    ...options };
  state.ddls = new Map(ingestSchemaDefinitions().map(({ table, ddl }) => {
    const definition = ddl.replace(/AUTO_INCREMENT=[0-9]+$/, `AUTO_INCREMENT=${state.capturedCounter}`);
    return [table, table === processing && state.columnPresent ? withFlag(definition) : definition];
  }));
  state.columns = new Map(names.map(table => [table, [...REQUIRED_BIOMETRIC_COLUMNS[table], ...(table === processing && state.columnPresent ? [flag] : [])]]));
  state.rows = new Map(names.map(table => {
    const row = Object.fromEntries(state.columns.get(table).map(column => [column, null]));
    row[key(table)] = '1';
    if (Object.hasOwn(row, 'notes')) row.notes = 'Synthetic private person/event details';
    if (Object.hasOwn(row, 'safe_capabilities')) row.safe_capabilities = '{"precise":900719925474099312345,"x":"نص"}';
    if (table === processing && state.columnPresent) row[flag] = 1;
    return [table, [row]];
  }));
  const fileStore = {
    async exists(file) { return state.files.has(file); },
    async writeExclusive(file, text) {
      state.writes.push({ file, text, callCount: state.calls.length });
      if (state.files.has(file) || (state.envCollision && file === privatePath)) throw Object.assign(new Error('Synthetic private collision'), { code: 'EEXIST' });
      state.files.set(file, text);
    },
    async readText(file) {
      if (state.corruptBackup && file.endsWith(`${processing}.rows.json`)) return '[]';
      if (!state.files.has(file)) throw new Error('Synthetic missing backup');
      return state.files.get(file);
    },
    async createBackupDirectory(parent) { assert.equal(parent, backupParent); state.backupDirectories++; return backupDirectory; },
    async writeReport(file, text) { state.reports.push({ file, text }); }
  };
  const createConnection = async settings => {
    state.connections.push(settings);
    async function answer(method, options, params = []) {
      const { sql } = options; state.calls.push({ method, sql, params, timeout: options.timeout });
      if (state.rejectSql?.(sql)) throw Object.assign(new Error('Private SQL and credentials must not escape'), { code: 'ER_SYNTHETIC_PREPARATION' });
      if (sql === 'SELECT DATABASE() AS current_database') return [[{ current_database: state.selected }], []];
      if (sql.includes('TABLE_TYPE')) return [state.tableSet ?? names.map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: 'BASE TABLE', AUTO_INCREMENT: TABLE_NAME === processing ? null : state.metadataCounter })), []];
      if (sql.startsWith('SELECT COLUMN_NAME,COLUMN_TYPE')) return [state.columnPresent ? [{ COLUMN_NAME: flag,
        COLUMN_TYPE: state.invalidColumn ? 'varchar(1)' : 'tinyint(3) unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0', EXTRA: '' }] : [], []];
      if (sql === 'SELECT CURRENT_ROLE() AS active_roles') return [[{ active_roles: 'NONE' }], []];
      if (sql === 'SHOW GRANTS FOR CURRENT_USER()') return [[{ Grant: `GRANT ${state.privileges.join(', ')} ON *.* TO '${prefix}.root'@'%'${state.grantOption ? ' WITH GRANT OPTION' : ''}` }], []];
      if (sql.includes('information_schema.COLUMNS')) return [names.flatMap(table => state.columns.get(table).map(COLUMN_NAME => ({ TABLE_NAME: table, COLUMN_NAME }))), []];
      if (sql.includes('information_schema.TABLES')) return [names.map(TABLE_NAME => ({ TABLE_NAME, TABLE_COLLATION: 'utf8mb4_bin' })), []];
      if (sql.includes('information_schema.STATISTICS')) return [Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES)
        .flatMap(([table, indexes]) => Object.entries(indexes).flatMap(([index, columns]) => columns.map((COLUMN_NAME, n) =>
          ({ TABLE_NAME: table, INDEX_NAME: index, NON_UNIQUE: 0, SEQ_IN_INDEX: n + 1, COLUMN_NAME })))), []];
      const show = /^SHOW CREATE TABLE `fingerprint`\.`([^`]+)`$/.exec(sql);
      if (show) return [[{ Table: show[1], 'Create Table': state.ddls.get(show[1]) }], []];
      if (sql.startsWith('SELECT COUNT(*) AS nonzero')) return [[{ nonzero: state.rows.get(processing).filter(row => row[flag] !== 0).length }], []];
      const projection = /^SELECT (.+) FROM `fingerprint`\.`([^`]+)` ORDER BY `[^`]+`$/.exec(sql);
      if (projection) {
        const columns = projection[1].split(',').map(value => value.trim().slice(1, -1));
        return [state.rows.get(projection[2]).map(row => Object.fromEntries(columns.map(column => [column, row[column]]))), []];
      }
      if (sql.startsWith('ALTER TABLE ')) {
        assert.equal(sql, 'ALTER TABLE `fingerprint`.`biometric_svc_event_processing` ADD COLUMN `automatic_finalization_eligible` TINYINT UNSIGNED NOT NULL DEFAULT 0');
        state.columnPresent = true; state.columns.get(processing).push(flag); state.ddls.set(processing, withFlag(state.ddls.get(processing)));
        for (const row of state.rows.get(processing)) row[flag] = state.unexpectedNewFlag ? 1 : 0;
        if (state.changeAfterAlter) state.rows.get(BIOMETRIC_TABLES.devices)[0].notes = 'Concurrent synthetic change';
        if (state.changeDdlAfterAlter) state.ddls.set(BIOMETRIC_TABLES.devices, state.ddls.get(BIOMETRIC_TABLES.devices).replace('varchar(255)', 'varchar(254)'));
        return [{ affectedRows: 0 }, []];
      }
      if (/^CREATE USER\b|^GRANT (?:SELECT|INSERT|UPDATE)/.test(sql)) return [{ affectedRows: 0 }, []];
      throw new Error('Unexpected synthetic preparation SQL');
    }
    return { execute: (sql, params) => answer('execute', sql, params), query: (sql, params) => answer('query', sql, params),
      async end() { state.closed++; }, destroy() { state.destroyed++; } };
  };
  const exportBackup = async ({ schema, purpose, writeRowsFile }) => {
    state.exportCalls++;
    assert.equal(schema, 'fingerprint'); assert.equal(purpose, 'standalone-destination');
    const tables = [];
    for (const name of names) {
      const columns = [...state.columns.get(name)];
      const rows = state.rows.get(name).map(row => ({ ...row }));
      const rowsFile = `${name}.rows.json`;
      await writeRowsFile(rowsFile, rows.map(row => serializeRow(row, columns)));
      tables.push({ name, columns, rowsFile, ddl: state.ddls.get(name), rowCount: rows.length,
        rowsSha256: canonicalRowsHash(columns, rows), primaryKey: key(name), autoIncrement: name === processing ? null : state.capturedCounter, maxKey: '1' });
    }
    if (state.changeAfterBackup) state.rows.get(BIOMETRIC_TABLES.devices)[0].notes = 'Concurrent synthetic change';
    if (state.ddlCounterAfterBackup !== undefined) for (const [table, ddl] of state.ddls) {
      state.ddls.set(table, ddl.replace(/AUTO_INCREMENT=[0-9]+$/, `AUTO_INCREMENT=${state.ddlCounterAfterBackup}`));
    }
    return { format: 'biometric-backup-v1', purpose, schema, snapshotAt: '2026-11-09 12:00:00.123456', consistentSnapshot: true, tables };
  };
  const verifyWriter = async config => {
    state.verifiedWriters.push(config);
    if (state.writerRejects) throw Object.assign(new Error('Private writer details'), { code: 'INGEST_DATABASE_GRANTS_REJECTED' });
  };
  return { state, run: options => prepareCloudIngestDatabase({ env, createConnection, verifyWriter, exportBackup, fileStore,
    privateEnvPath: privatePath, reportPath, backupDirectoryParent: backupParent, ...options }) };
}

function mutations(state) { return state.calls.filter(call => !/^(?:SELECT|SHOW)\b/.test(call.sql)); }
function values(text) { return Object.fromEntries(text.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
  const separator = line.indexOf('='); return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
})); }

test('default plan inspects schema and exact grant ability without creating backup directories, credentials or SQL mutations', async () => {
  const f = fixture(); const report = await f.run();
  assert.equal(report.passed, true); assert.equal(report.mode, 'plan');
  assert.equal(report.plan.addEligibilityColumn, true);
  assert.deepEqual(report.plan.grants, INGEST_TABLE_PRIVILEGES);
  assert.equal(f.state.exportCalls, 0); assert.equal(f.state.backupDirectories, 0); assert.equal(f.state.files.size, 0);
  assert.deepEqual(mutations(f.state), []); assert.equal(f.state.verifiedWriters.length, 0);
  assert.equal(f.state.reports.length, 1);
  assert.deepEqual(f.state.connections[0].ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true });
  assert.equal(f.state.connections[0].jsonStrings, true);
});

test('source configuration, wrong target and existing private credentials fail before any connection', async () => {
  for (const change of [{ TIDB_SETUP_DATABASE: 'test' }, { TIDB_SOURCE_HOST: 'original.invalid' },
    { TIDB_SOURCE_PASSWORD: 'Synthetic-source-password' }, { TIDB_SETUP_USER: `${prefix}.reader` }]) {
    const f = fixture(); const report = await f.run({ apply: true, env: { ...env, ...change } });
    assert.equal(report.passed, false); assert.equal(f.state.connections.length, 0); assert.equal(f.state.files.size, 0);
  }
  const text = 'Preserve existing generated account';
  const existing = fixture({ files: new Map([[privatePath, text]]) });
  assert.equal((await existing.run({ apply: true })).failure.code, 'CLOUD_INGEST_PRIVATE_ENV_EXISTS');
  assert.equal(existing.state.connections.length, 0); assert.equal(existing.state.files.get(privatePath), text);
});

test('wrong selected schema, marker tables, invalid column or insufficient grant and ALTER ability prevent backup and mutation', async () => {
  for (const change of [{ selected: 'test' }, { columnPresent: true, invalidColumn: true },
    { privileges: ['SELECT', 'INSERT', 'UPDATE', 'CREATE USER'] }, { grantOption: false },
    { tableSet: [...names.map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: 'BASE TABLE' })), { TABLE_NAME: 'biometric_portal_test_identity', TABLE_TYPE: 'BASE TABLE' }] }]) {
    const f = fixture(change); const report = await f.run({ apply: true });
    assert.equal(report.passed, false); assert.equal(f.state.exportCalls, 0); assert.deepEqual(mutations(f.state), []);
    assert.equal(f.state.files.has(privatePath), false);
  }
});

test('apply saves and reads back a fresh full typed backup before the single allowed ALTER and exact writer grants', async () => {
  const f = fixture(); const report = await f.run({ apply: true });
  assert.equal(report.passed, true, JSON.stringify(report.failure));
  assert.equal(report.backup.fileHashesVerified, true); assert.equal(report.backup.consistentSnapshot, true);
  assert.equal(report.backup.restoreRehearsalPerformed, false);
  assert.equal(Object.keys(report.backup.counts).length, 10); assert.equal(f.state.files.size, 12);
  const writers = mutations(f.state), firstMutation = f.state.calls.indexOf(writers[0]);
  assert.ok(f.state.writes.every(write => write.callCount <= firstMutation));
  assert.equal(writers.filter(call => call.sql.startsWith('ALTER TABLE')).length, 1);
  assert.equal(writers.filter(call => call.sql.startsWith('CREATE USER')).length, 1);
  const grants = writers.filter(call => call.sql.startsWith('GRANT '));
  assert.equal(grants.length, 10);
  for (const [table, privileges] of Object.entries(INGEST_TABLE_PRIVILEGES)) {
    assert.equal(grants.some(call => call.sql.startsWith(`GRANT ${privileges.join(',')} ON \`fingerprint\`.\`${table}\` TO `)), true);
  }
  assert.equal(writers.some(call => /^(?:DROP|INSERT|DELETE|UPDATE|REVOKE)\b/.test(call.sql)), false);
  assert.equal(report.oldRowsAndDdlVerified, true); assert.equal(report.eligibilityColumnAdded, true);
  const credentials = values(f.state.files.get(privatePath));
  assert.match(credentials.BIOMETRIC_INGEST_DB_USER, new RegExp(`^${prefix}\\.fp_ing_[a-f0-9]{8}$`));
  assert.ok(credentials.BIOMETRIC_INGEST_DB_USER.length <= 32);
  assert.equal(Object.keys(credentials).every(key => key.startsWith('BIOMETRIC_INGEST_DB_')), true);
  assert.equal(credentials.BIOMETRIC_INGEST_DB_NAME, 'fingerprint');
  assert.equal(credentials.BIOMETRIC_INGEST_DB_CONFIRMED_NAME, 'fingerprint');
  assert.equal(f.state.verifiedWriters[0].user, credentials.BIOMETRIC_INGEST_DB_USER);
  assert.equal(f.state.verifiedWriters[0].password, credentials.BIOMETRIC_INGEST_DB_PASSWORD);
  assert.equal(f.state.verifiedWriters[0].user.endsWith('.root'), false);
  const publicOutput = JSON.stringify(report) + f.state.reports.map(item => item.text).join('');
  for (const secret of [env.TIDB_SETUP_PASSWORD, env.TIDB_SETUP_USER, credentials.BIOMETRIC_INGEST_DB_USER,
    credentials.BIOMETRIC_INGEST_DB_PASSWORD, 'Synthetic private person/event details', 'IDENTIFIED BY']) assert.equal(publicOutput.includes(secret), false);
});

test('an existing valid column skips ALTER and preserves nonzero eligibility values exactly', async () => {
  const f = fixture({ columnPresent: true, privileges: ['SELECT', 'INSERT', 'UPDATE', 'CREATE USER'] });
  const before = f.state.rows.get(processing)[0][flag];
  const report = await f.run({ apply: true });
  assert.equal(report.passed, true, JSON.stringify(report.failure));
  assert.equal(before, 1); assert.equal(f.state.rows.get(processing)[0][flag], 1);
  assert.equal(report.existingEligibilityValuesPreserved, true); assert.equal(report.eligibilityColumnAdded, false);
  assert.equal(mutations(f.state).some(call => call.sql.startsWith('ALTER')), false);
});

test('TiDB local cached or uncached counters below the global DDL high mark do not report a false regression', async () => {
  for (const metadataCounter of ['970000', '0']) {
    const f = fixture({ metadataCounter }); const report = await f.run({ apply: true });
    assert.equal(report.passed, true, JSON.stringify(report.failure));
    assert.equal(report.oldRowsAndDdlVerified, true);
    assert.equal(mutations(f.state).filter(call => call.sql.startsWith('ALTER TABLE ')).length, 1);
    assert.equal(mutations(f.state).some(call => /\b(?:AUTO_INCREMENT\s*=|REBASE)\b/i.test(call.sql)), false);
  }
});

test('a regressed global allocator fails before mutations even when a higher local value would mask it', async () => {
  for (const metadataCounter of ['940000', '1000000']) {
    const f = fixture({ metadataCounter, ddlCounterAfterBackup: '970000' });
    const report = await f.run({ apply: true });
    assert.equal(report.passed, false);
    assert.equal(report.failure.code, 'CLOUD_INGEST_COUNTER_CHANGED_UNSAFELY');
    assert.equal(report.failure.stage, 'recheck-current-destination');
    assert.deepEqual(mutations(f.state), []); assert.equal(f.state.files.has(privatePath), false);
  }
});

test('invalid local metadata and zero global counters cannot be hidden by taking a maximum', async () => {
  for (const metadataCounter of [null, undefined, '-1', 'not-a-counter', 9007199254740992]) {
    const f = fixture({ metadataCounter }); const report = await f.run({ apply: true });
    assert.equal(report.failure.code, 'CLOUD_INGEST_COUNTER_CHANGED_UNSAFELY');
    assert.deepEqual(mutations(f.state), []); assert.equal(f.state.files.has(privatePath), false);
  }
  const zero = fixture({ ddlCounterAfterBackup: '0' }); const report = await zero.run({ apply: true });
  assert.equal(report.failure.code, 'CLOUD_INGEST_COUNTER_CHANGED_UNSAFELY');
  assert.deepEqual(mutations(zero.state), []); assert.equal(zero.state.files.has(privatePath), false);
});

test('backup corruption and a pre-ALTER data change stop before credentials and every SQL mutation', async () => {
  for (const change of [{ corruptBackup: true }, { changeAfterBackup: true }]) {
    const f = fixture(change); const report = await f.run({ apply: true });
    assert.equal(report.passed, false); assert.deepEqual(mutations(f.state), []);
    assert.equal(f.state.files.has(privatePath), false); assert.equal(f.state.verifiedWriters.length, 0);
  }
});

test('post-ALTER old-row or old-DDL changes retain evidence and credentials without creating or activating a writer', async () => {
  for (const change of [{ changeAfterAlter: true }, { changeDdlAfterAlter: true }, { unexpectedNewFlag: true }]) {
    const f = fixture(change); const report = await f.run({ apply: true });
    assert.equal(report.passed, false); assert.equal(report.partialPreparationPossible, true);
    assert.equal(report.backup.fileHashesVerified, true); assert.equal(f.state.files.has(privatePath), true);
    assert.equal(mutations(f.state).length, 1); assert.equal(f.state.verifiedWriters.length, 0);
    assert.equal(report.ingestActivated, false);
  }
});

test('partial grant failure records exact progress and retains additive resources without automatic rollback', async () => {
  let grant = 0;
  const f = fixture({ rejectSql: sql => sql.startsWith('GRANT ') && ++grant === 3 });
  const report = await f.run({ apply: true });
  assert.equal(report.passed, false); assert.equal(report.failure.code, 'ER_SYNTHETIC_PREPARATION');
  assert.equal(report.failedOperation, report.attemptedOperations.at(-1));
  assert.equal(report.completedOperations.includes('create-new-ingest-writer'), true);
  assert.equal(report.partialPreparationPossible, true); assert.equal(f.state.files.has(privatePath), true);
  assert.equal(report.backup.fileHashesVerified, true); assert.equal(report.ingestActivated, false);
  assert.equal(f.state.calls.some(call => /^(?:DROP|REVOKE|DELETE|UPDATE|INSERT)\b/.test(call.sql)), false);
  assert.equal(f.state.closed, 1);
});

test('writer guard rejection preserves completed preparation but reports failure and leaves runtime inactive', async () => {
  const f = fixture({ writerRejects: true }); const report = await f.run({ apply: true });
  assert.equal(report.passed, false); assert.equal(report.failure.stage, 'verify-ingest-writer-with-runtime-guard');
  assert.equal(report.failure.code, 'INGEST_DATABASE_GRANTS_REJECTED');
  assert.equal(report.partialPreparationPossible, true); assert.equal(report.privateEnvWritten, true);
  assert.equal(report.failedOperation, null); assert.equal(report.ingestActivated, false);
});
