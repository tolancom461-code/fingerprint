import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIOMETRIC_TABLES,
  REQUIRED_BIOMETRIC_COLUMNS,
  REQUIRED_BIOMETRIC_UNIQUE_INDEXES
} from '../src/infrastructure/storage/biometric-table-names.js';
import { assertBiometricDatabaseReady, detectDeviceUserIdentitySchema } from '../src/infrastructure/database/schema-check.js';

const deviceUsers = BIOMETRIC_TABLES.deviceUsers;
const punches = BIOMETRIC_TABLES.punches;
const identityColumns = [
  ...['identity_started_at', 'identity_ended_at'].map(name => ({ TABLE_NAME: deviceUsers, COLUMN_NAME: name,
    DATA_TYPE: 'datetime', IS_NULLABLE: 'YES', DATETIME_PRECISION: 6 })),
  { TABLE_NAME: deviceUsers, COLUMN_NAME: 'current_device_user_id', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES',
    CHARACTER_MAXIMUM_LENGTH: 128, COLLATION_NAME: 'utf8mb4_bin', EXTRA: 'VIRTUAL GENERATED',
    GENERATION_EXPRESSION: "(case when (`status` = _utf8mb4\\'absent_from_device\\') then NULL else `device_user_id` end)" },
  { TABLE_NAME: punches, COLUMN_NAME: 'device_user_row_id', COLUMN_TYPE: 'bigint unsigned', IS_NULLABLE: 'YES' }
];
const identityIndexes = [
  [deviceUsers, 'uq_biometric_svc_device_user_current', 0, ['device_id', 'current_device_user_id']],
  [deviceUsers, 'idx_biometric_svc_device_users_device_pin', 1, ['device_id', 'device_user_id']],
  [punches, 'idx_biometric_svc_punches_device_user_row_id', 1, ['device_user_row_id']]
];

function poolWithSchema({ database = 'test', omitColumn = null, omitIndex = null, badCollation = null,
  addedColumns = [], addedIndexes = [], replaceLegacyKey = false } = {}) {
  return {
    async execute(sql) {
      if (sql.includes('SELECT DATABASE()')) return [[{ current_database: database }]];
      if (sql.includes('information_schema.COLUMNS')) {
        const rows = [];
        for (const [table, columns] of Object.entries(REQUIRED_BIOMETRIC_COLUMNS)) {
          for (const column of columns) {
            if (omitColumn?.table === table && omitColumn?.column === column) continue;
            rows.push({ TABLE_NAME: table, COLUMN_NAME: column });
          }
        }
        return [[...rows, ...addedColumns]];
      }
      if (sql.includes('information_schema.TABLES')) {
        return [Object.values(BIOMETRIC_TABLES).map((table) => ({
          TABLE_NAME: table,
          TABLE_COLLATION: badCollation === table ? 'utf8mb4_unicode_ci' : 'utf8mb4_bin'
        }))];
      }
      if (sql.includes('information_schema.STATISTICS')) {
        const rows = [];
        for (const [table, indexes] of Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES)) {
          for (const [index, columns] of Object.entries(indexes)) {
            if (omitIndex?.table === table && omitIndex?.index === index) continue;
            if (replaceLegacyKey && table === deviceUsers && index === 'uq_biometric_svc_device_user') continue;
            columns.forEach((column, i) => rows.push({
              TABLE_NAME: table, INDEX_NAME: index, NON_UNIQUE: 0, SEQ_IN_INDEX: i + 1, COLUMN_NAME: column
            }));
          }
        }
        for (const [table, index, nonUnique, columns] of addedIndexes) {
          columns.forEach((column, i) => rows.push({
            TABLE_NAME: table, INDEX_NAME: index, NON_UNIQUE: nonUnique, SEQ_IN_INDEX: i + 1, COLUMN_NAME: column
          }));
        }
        return [rows];
      }
      return [[]];
    }
  };
}

test('database readiness check accepts the exact biometric schema contract', async () => {
  const pool = poolWithSchema();
  assert.deepEqual(await assertBiometricDatabaseReady(pool, 'test'), { database: 'test', tableCount: 10 });
  assert.equal(await detectDeviceUserIdentitySchema(pool), false);
});

test('database readiness accepts only the complete enrollment identity schema', async () => {
  const pool = poolWithSchema({ database: 'fingerprint', addedColumns: identityColumns,
    addedIndexes: identityIndexes, replaceLegacyKey: true });
  assert.deepEqual(await assertBiometricDatabaseReady(pool, 'fingerprint'), {
    database: 'fingerprint', tableCount: 10, deviceUserIdentityEnabled: true
  });
  assert.equal(await detectDeviceUserIdentitySchema(pool), true);
});

test('database readiness rejects partial and incorrect enrollment identity migrations', async () => {
  const complete = { database: 'fingerprint', addedColumns: identityColumns,
    addedIndexes: identityIndexes, replaceLegacyKey: true };
  for (const shape of [
    { addedColumns: identityColumns.slice(0, 1) },
    { ...complete, replaceLegacyKey: false },
    { ...complete, addedIndexes: identityIndexes.slice(0, 1) },
    { ...complete, addedColumns: identityColumns.map(column => column.COLUMN_NAME === 'current_device_user_id'
      ? { ...column, GENERATION_EXPRESSION: '`device_user_id`' } : column) }
  ]) {
    const pool = poolWithSchema(shape);
    const rejected = { code: 'DEVICE_USER_IDENTITY_SCHEMA_INCOMPLETE' };
    await assert.rejects(assertBiometricDatabaseReady(pool, shape.database ?? 'test'), rejected);
    await assert.rejects(detectDeviceUserIdentitySchema(pool), rejected);
  }
});

test('database readiness check fails closed on wrong database', async () => {
  await assert.rejects(assertBiometricDatabaseReady(poolWithSchema({ database: 'other' }), 'test'), /unexpected database/);
});

test('database readiness check fails closed when a required column is missing', async () => {
  const table = BIOMETRIC_TABLES.devices;
  await assert.rejects(
    assertBiometricDatabaseReady(poolWithSchema({ omitColumn: { table, column: 'vendor' } }), 'test'),
    /missing columns/
  );
});

test('database readiness check fails closed on wrong table collation', async () => {
  await assert.rejects(
    assertBiometricDatabaseReady(poolWithSchema({ badCollation: BIOMETRIC_TABLES.punches }), 'test'),
    /utf8mb4_bin/
  );
});

test('database readiness check fails closed when a critical idempotency index is missing', async () => {
  await assert.rejects(
    assertBiometricDatabaseReady(poolWithSchema({ omitIndex: { table: BIOMETRIC_TABLES.ingestEvents, index: 'uq_biometric_svc_ingest_key' } }), 'test'),
    /invalid or missing unique index/
  );
});
