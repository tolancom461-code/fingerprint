import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIOMETRIC_TABLES,
  REQUIRED_BIOMETRIC_COLUMNS,
  REQUIRED_BIOMETRIC_UNIQUE_INDEXES
} from '../src/infrastructure/storage/biometric-table-names.js';
import { assertBiometricDatabaseReady } from '../src/infrastructure/database/schema-check.js';

function poolWithSchema({ database = 'test', omitColumn = null, omitIndex = null, badCollation = null } = {}) {
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
        return [rows];
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
            columns.forEach((column, i) => rows.push({
              TABLE_NAME: table, INDEX_NAME: index, NON_UNIQUE: 0, SEQ_IN_INDEX: i + 1, COLUMN_NAME: column
            }));
          }
        }
        return [rows];
      }
      return [[]];
    }
  };
}

test('database readiness check accepts the exact biometric schema contract', async () => {
  const result = await assertBiometricDatabaseReady(poolWithSchema(), 'test');
  assert.equal(result.database, 'test');
  assert.equal(result.tableCount, 10);
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
