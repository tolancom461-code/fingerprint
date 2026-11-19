import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbProgramConnectionsStore } from '../src/infrastructure/storage/tidb-program-connections-store.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const HASH = 'a'.repeat(64);
function fixture() {
  const columns = Object.entries({
    id: ['char', 36, false, 'ascii_bin'], program_name: ['varchar', 100, false, 'utf8mb4_bin'],
    token_hash: ['char', 64, false, 'ascii_bin'], token_prefix: ['varchar', 12, false, 'ascii_bin'],
    status: ['varchar', 16, false, 'ascii_bin'], created_by: ['varchar', 128, false, 'utf8mb4_bin'],
    created_at: ['datetime', 6, false, null], revoked_at: ['datetime', 6, true, null], revoked_by: ['varchar', 128, true, 'utf8mb4_bin'],
  }).map(([name, [type, size, nullable, collation]]) => ({ COLUMN_NAME: name, DATA_TYPE: type,
    CHARACTER_MAXIMUM_LENGTH: type === 'datetime' ? null : size, DATETIME_PRECISION: type === 'datetime' ? size : null,
    IS_NULLABLE: nullable ? 'YES' : 'NO', COLLATION_NAME: collation, COLUMN_DEFAULT: name === 'created_at' ? 'CURRENT_TIMESTAMP(6)' : null, EXTRA: '' }));
  const indexes = Object.entries({ PRIMARY: [0, ['id']], uq_biometric_svc_program_token_hash: [0, ['token_hash']],
    idx_biometric_svc_program_status_created: [1, ['status', 'created_at', 'id']] }).flatMap(([name, [nonUnique, fields]]) =>
    fields.map((field, index) => ({ INDEX_NAME: name, NON_UNIQUE: nonUnique, SEQ_IN_INDEX: index + 1, COLUMN_NAME: field, SUB_PART: null })));
  const tables = [{ ENGINE: 'InnoDB', TABLE_TYPE: 'BASE TABLE' }];
  const calls = [];
  const rows = new Map();
  const pool = { async execute(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes('information_schema.TABLES')) return [tables];
    if (sql.includes('information_schema.COLUMNS')) return [columns];
    if (sql.includes('information_schema.STATISTICS')) return [indexes];
    if (sql.startsWith('INSERT')) {
      const [id, name, hash, prefix, actor] = params;
      rows.set(id, { id, program_name: name, token_hash: hash, token_prefix: prefix, status: 'active', created_by: actor,
        created_at_utc: '2026-11-19T10:00:00.123456Z', revoked_at_utc: null, revoked_by: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE')) {
      const row = rows.get(params[1]);
      if (!row || row.status !== 'active') return [{ affectedRows: 0 }];
      Object.assign(row, { status: 'revoked', revoked_at_utc: '2026-11-19T10:01:00.123456Z', revoked_by: params[0] });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('WHERE token_hash = ?')) return [[...rows.values()].filter(row => row.token_hash === params[0] && row.status === 'active')];
    if (sql.includes('WHERE id = ?')) return [[...rows.values()].filter(row => row.id === params[0])];
    return [[...rows.values()]];
  } };
  return { store: new TiDbProgramConnectionsStore(pool), pool, calls, rows, tables, columns, indexes };
}

test('store is inert until used, validates optional schema once and writes explicit UTC without plaintext', async () => {
  const { store, calls } = fixture();
  assert.equal(calls.length, 0);
  const created = await store.create({ id: ID, programName: "Program ' named", tokenHash: HASH, tokenPrefix: 'abcdefghijkl', actor: 'admin' });
  assert.equal(created.id, ID);
  assert.equal(created.createdAtUtc, '2026-11-19T10:00:00.123456Z');
  assert.equal('token_hash' in created, false);
  const inserted = calls.find(call => call.sql.startsWith('INSERT'));
  assert.match(inserted.sql, /UTC_TIMESTAMP\(6\), NULL, NULL/);
  assert.equal(inserted.sql.includes("Program ' named"), false);
  assert.deepEqual(inserted.params, [ID, "Program ' named", HASH, 'abcdefghijkl', 'admin']);
  await store.list();
  assert.equal(calls.filter(call => call.sql.includes('information_schema.COLUMNS')).length, 1);
  assert.match(calls.at(-1).sql, /LIMIT 200$/);
});

test('active hash lookup always selects again; revocation is conditional and preserves first actor', async () => {
  const { store, calls } = fixture();
  await store.create({ id: ID, programName: 'Program', tokenHash: HASH, tokenPrefix: 'abcdefghijkl', actor: 'admin' });
  assert.equal((await store.findActiveByTokenHash(HASH)).id, ID);
  assert.equal((await store.findActiveByTokenHash(HASH)).id, ID);
  const revoked = await store.revoke({ id: ID, actor: 'first-operator' });
  assert.equal(await store.findActiveByTokenHash(HASH), null);
  assert.deepEqual(await store.revoke({ id: ID, actor: 'second-operator' }), revoked);
  assert.equal(revoked.revokedBy, 'first-operator');
  const updates = calls.filter(call => call.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 2);
  assert.ok(updates.every(call => /WHERE id = \? AND status = 'active'/.test(call.sql)));
  assert.equal(calls.filter(call => call.sql.includes('WHERE token_hash = ?')).length, 3);
  assert.equal(await store.revoke({ id: '123e4567-e89b-42d3-a456-426614174001', actor: 'admin' }), null);
});

test('readiness rejects missing, unsafe engine, nullable defaults, bad columns and missing token uniqueness before writes', async () => {
  const mutations = [f => f.tables.splice(0), f => { f.tables[0].ENGINE = 'MyISAM'; },
    f => { f.columns.find(column => column.COLUMN_NAME === 'revoked_at').COLUMN_DEFAULT = 'CURRENT_TIMESTAMP(6)'; },
    f => { f.columns.find(column => column.COLUMN_NAME === 'token_hash').COLLATION_NAME = 'utf8mb4_general_ci'; },
    f => { f.columns.find(column => column.COLUMN_NAME === 'id').CHARACTER_MAXIMUM_LENGTH = 32; },
    f => { f.indexes.find(index => index.INDEX_NAME === 'uq_biometric_svc_program_token_hash').NON_UNIQUE = 1; },
    f => { f.indexes.push({ INDEX_NAME: 'extra_unique', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'program_name', SUB_PART: null }); }];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(() => f.store.create({ id: ID, programName: 'Program', tokenHash: HASH, tokenPrefix: 'abcdefghijkl', actor: 'admin' }),
      error => error.code === 'PROGRAM_CONNECTIONS_SCHEMA_NOT_READY');
    assert.equal(f.calls.some(call => call.sql.startsWith('INSERT')), false);
  }
});

test('invalid parameters never query; missing-table and driver errors remain fixed and secret-free', async () => {
  const f = fixture();
  await assert.rejects(() => f.store.findActiveByTokenHash('SYNTHETIC-SECRET'), error => error.code === 'PROGRAM_CONNECTION_INVALID_INPUT');
  await assert.rejects(() => f.store.revoke({ id: 'bad-id', actor: 'admin' }), error => error.code === 'PROGRAM_CONNECTION_INVALID_INPUT');
  assert.equal(f.calls.length, 0);
  f.pool.execute = async () => { throw Object.assign(new Error('SYNTHETIC-SECRET-SQL'), { code: 'ER_NO_SUCH_TABLE' }); };
  await assert.rejects(() => f.store.list(), error => error.code === 'PROGRAM_CONNECTIONS_SCHEMA_NOT_READY' && !String(error.stack).includes('SYNTHETIC'));
  f.pool.execute = async () => { throw new Error('SYNTHETIC-SECRET-SQL'); };
  await assert.rejects(() => f.store.list(), error => error.code === 'PROGRAM_CONNECTIONS_UNAVAILABLE' && !String(error.stack).includes('SYNTHETIC'));
});
