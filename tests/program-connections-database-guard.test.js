import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestDatabase, INGEST_TABLE_PRIVILEGES } from '../src/infrastructure/database/ingest-database.js';
import { BIOMETRIC_TABLES, REQUIRED_BIOMETRIC_COLUMNS, REQUIRED_BIOMETRIC_UNIQUE_INDEXES } from '../src/infrastructure/storage/biometric-table-names.js';
import { TiDbProgramConnectionsStore } from '../src/infrastructure/storage/tidb-program-connections-store.js';
import { TiDbSourcePunchesReadStore } from '../src/infrastructure/storage/tidb-source-punches-read-store.js';

const table = 'biometric_svc_program_connections';
const config = { host: 'fixture.invalid', user: 'synthetic_writer', password: 'fixture-only-password',
  database: 'fingerprint', confirmedName: 'fingerprint', sslMode: 'required',
  connectTimeoutMs: 100, queryTimeoutMs: 100, transactionTimeoutMs: 1000 };
function fixture({ grant = true, badCollation = false } = {}) {
  const state = { calls: [], rows: [], ended: 0 };
  const specs = [
    ['id', 'char', 36, false, 'ascii_bin'], ['program_name', 'varchar', 100, false, 'utf8mb4_bin'],
    ['token_hash', 'char', 64, false, 'ascii_bin'], ['token_prefix', 'varchar', 12, false, 'ascii_bin'],
    ['status', 'varchar', 16, false, 'ascii_bin'], ['created_by', 'varchar', 128, false, 'utf8mb4_bin'],
    ['created_at', 'datetime', 6, false, null], ['revoked_at', 'datetime', 6, true, null],
    ['revoked_by', 'varchar', 128, true, 'utf8mb4_bin'],
  ];
  const programColumns = specs.map(([name, type, size, nullable, collation]) => ({
    COLUMN_NAME: name, DATA_TYPE: type, CHARACTER_MAXIMUM_LENGTH: type === 'datetime' ? null : size,
    DATETIME_PRECISION: type === 'datetime' ? size : null, IS_NULLABLE: nullable ? 'YES' : 'NO',
    COLLATION_NAME: badCollation && name === 'token_hash' ? 'ascii_general_ci' : collation,
    COLUMN_DEFAULT: name === 'created_at' ? 'CURRENT_TIMESTAMP(6)' : null,
    EXTRA: name === 'created_at' ? 'DEFAULT_GENERATED' : '',
  }));
  const programIndexes = Object.entries({ PRIMARY: [0, ['id']], uq_biometric_svc_program_token_hash: [0, ['token_hash']],
    idx_biometric_svc_program_status_created: [1, ['status', 'created_at', 'id']] }).flatMap(([name, [nonUnique, fields]]) =>
    fields.map((column, index) => ({ INDEX_NAME: name, NON_UNIQUE: nonUnique, SEQ_IN_INDEX: index + 1, COLUMN_NAME: column, SUB_PART: null })));
  async function answer(options, params = []) {
    const sql = options.sql;
    state.calls.push({ sql, params });
    if (sql === 'SELECT DATABASE() AS current_database') return [[{ current_database: 'fingerprint' }], []];
    if (sql === 'SELECT CURRENT_ROLE() AS active_roles') return [[{ active_roles: 'NONE' }], []];
    if (sql === 'SHOW GRANTS FOR CURRENT_USER()') return [[
      ...Object.entries(INGEST_TABLE_PRIVILEGES).map(([name, values]) => ({ grant: `GRANT ${values.join(', ')} ON fingerprint.${name} TO 'fixture'@'%'` })),
      ...(grant ? [{ grant: `GRANT SELECT, INSERT, UPDATE ON fingerprint.${table} TO 'fixture'@'%'` }] : []),
    ], []];
    if (sql.includes('information_schema.COLUMNS')) {
      if (params[0] === table) return [programColumns, []];
      if (params.at(-1) === 'automatic_finalization_eligible') return [[
        { DATA_TYPE: 'tinyint', COLUMN_TYPE: 'tinyint unsigned', IS_NULLABLE: 'NO', COLUMN_DEFAULT: '0' },
      ], []];
      return [Object.entries(REQUIRED_BIOMETRIC_COLUMNS).flatMap(([name, columns]) => columns.map(column => ({ TABLE_NAME: name, COLUMN_NAME: column }))), []];
    }
    if (sql.includes('information_schema.TABLES')) return params[0] === table
      ? [[{ ENGINE: 'InnoDB', TABLE_TYPE: 'BASE TABLE' }], []]
      : [Object.values(BIOMETRIC_TABLES).map(TABLE_NAME => ({ TABLE_NAME, TABLE_COLLATION: 'utf8mb4_bin' })), []];
    if (sql.includes('information_schema.STATISTICS')) return params[0] === table ? [programIndexes, []]
      : [Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES).flatMap(([name, indexes]) => Object.entries(indexes)
        .flatMap(([key, fields]) => fields.map((column, index) => ({ TABLE_NAME: name, INDEX_NAME: key, NON_UNIQUE: 0,
          SEQ_IN_INDEX: index + 1, COLUMN_NAME: column })))), []];
    if (sql.startsWith(`INSERT INTO \`${table}\``)) {
      state.rows.push({ id: params[0], program_name: params[1], token_hash: params[2], token_prefix: params[3], status: 'active',
        created_by: params[4], created_at_utc: '2026-11-19T07:08:09.000000Z', revoked_at_utc: null, revoked_by: null });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith(`UPDATE \`${table}\``)) {
      const row = state.rows.find(item => item.id === params[1]);
      if (row) Object.assign(row, { status: 'revoked', revoked_by: params[0], revoked_at_utc: '2026-11-19T08:00:00.000000Z' });
      return [{ affectedRows: row ? 1 : 0 }, []];
    }
    if (sql.includes(`FROM \`${table}\``)) return [state.rows.filter(row =>
      sql.includes('WHERE token_hash') ? row.token_hash === params[0] && row.status === 'active'
        : sql.includes('WHERE id') ? row.id === params[0] : true), []];
    if (sql.trimStart().startsWith('SELECT')) return [[], []];
    throw new Error('Unexpected synthetic database operation');
  }
  const createPool = () => ({ async getConnection() { return { execute: answer, query: answer, release() {}, destroy() {} }; },
    async end() { state.ended++; } });
  return { state, createPool };
}

test('guard accepts the real program store metadata/read/write SQL only under explicit opt-in', async () => {
  const fixtureDb = fixture();
  const db = await createIngestDatabase({ ...config, programConnectionsEnabled: true }, { createPool: fixtureDb.createPool });
  try {
    const store = new TiDbProgramConnectionsStore(db);
    assert.deepEqual(await store.assertReady(), { ready: true });
    const saved = await store.create({ id: '1f999b36-e779-429b-b1d4-c6337d1e75c9', programName: 'Synthetic TolanHR',
      tokenHash: 'a'.repeat(64), tokenPrefix: 'abcdefghijkl', actor: 'fixture-admin' });
    assert.equal(saved.programName, 'Synthetic TolanHR');
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.findActiveByTokenHash('a'.repeat(64))).id, saved.id);
    await store.revoke({ id: saved.id, actor: 'fixture-admin' });
    assert.equal(await store.findActiveByTokenHash('a'.repeat(64)), null);
    await new TiDbSourcePunchesReadStore(db).listSourcePunchesAfter('18446744073709551614', 100);
    assert.equal(fixtureDb.state.calls.some(call => call.sql.includes('COALESCE(p.punch_state')), true);
  } finally { await db.end(); }
});

test('staged grants do not enable program queries and missing required grants stop opt-in startup', async () => {
  const staged = fixture();
  const db = await createIngestDatabase(config, { createPool: staged.createPool });
  try {
    for (const statement of [`SELECT id FROM ${table}`, `INSERT INTO ${table} (id) VALUES (?)`,
      `UPDATE ${table} SET status = 'revoked'`]) {
      await assert.rejects(db.execute(statement, []), { code: 'INGEST_DATABASE_QUERY_REJECTED' });
    }
  } finally { await db.end(); }
  const missing = fixture({ grant: false });
  await assert.rejects(createIngestDatabase({ ...config, programConnectionsEnabled: true }, { createPool: missing.createPool }),
    { code: 'INGEST_DATABASE_GRANTS_REJECTED' });
  assert.equal(missing.state.ended, 1);
});

test('program metadata mismatch stops the real store before data reads or writes', async () => {
  const bad = fixture({ badCollation: true });
  const db = await createIngestDatabase({ ...config, programConnectionsEnabled: true }, { createPool: bad.createPool });
  try {
    await assert.rejects(new TiDbProgramConnectionsStore(db).list(), { code: 'PROGRAM_CONNECTIONS_SCHEMA_NOT_READY' });
    assert.equal(bad.state.calls.some(call => call.sql.includes(`FROM \`${table}\``)), false);
  } finally { await db.end(); }
});
