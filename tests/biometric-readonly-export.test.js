import test from 'node:test';
import assert from 'node:assert/strict';
import { exportBiometricBackup } from '../scripts/lib/biometric-readonly-export.mjs';
import { MIGRATION_TABLES, BACKUP_TABLES, canonicalRowsHash, deserializeRow } from '../scripts/lib/biometric-backup-format.mjs';
import { REQUIRED_BIOMETRIC_COLUMNS } from '../src/infrastructure/storage/biometric-table-names.js';

const marker = 'biometric_portal_test_identity';
const snapshotAt = '2026-11-09 12:34:56.123456';
const secret = 'Synthetic private payload must not appear in errors';
const keyFor = name => name === marker ? 'instance_id' : name === 'biometric_svc_event_processing' ? 'ingest_event_id' : 'id';
const columnsFor = name => REQUIRED_BIOMETRIC_COLUMNS[name] ?? ['purpose', 'instance_id'];

function fixture({ destination = false, pageRows = 1, ...overrides } = {}) {
  const names = destination ? BACKUP_TABLES : MIGRATION_TABLES;
  const state = { calls: [], files: new Map(), waits: [], ddlReads: new Map(), metadataReads: 0,
    clock: snapshotAt, counts: new Map(), beforeCounter: '10', afterCounter: '20', ...overrides };
  const rowsByTable = new Map(names.map(name => {
    const length = name === names[0] ? pageRows : name === 'biometric_svc_audit_log' ? 0 : 1;
    const rows = Array.from({ length }, (_, index) => {
      const row = Object.fromEntries(columnsFor(name).map(column => [column, null]));
      row[keyFor(name)] = name === marker ? '48d47491-e7bf-4af5-b617-f361f193f5c4' : String(9007199254740993n + BigInt(index));
      if (name === marker) row.purpose = 'portal-isolated-test-v1';
      if (Object.hasOwn(row, 'notes')) row.notes = secret;
      if (Object.hasOwn(row, 'safe_capabilities')) row.safe_capabilities = '{"large":900719925474099312345,"text":"نص"}';
      if (Object.hasOwn(row, 'created_at')) row.created_at = '2026-11-09 12:00:00.123456';
      return row;
    });
    return [name, rows];
  }));
  state.rowsByTable = rowsByTable;
  const ddl = (name, after) => {
    const key = keyFor(name);
    const columns = columnsFor(name).map(column => `\`${column}\` ${column === key ? name === marker ? 'char(36)' : 'bigint unsigned' : 'text'}`);
    const suffix = name === marker || key === 'ingest_event_id' ? '' : ` AUTO_INCREMENT=${after ? state.afterCounter : state.beforeCounter}`;
    let value = `CREATE TABLE \`${name}\` (${columns.join(', ')}, PRIMARY KEY (\`${key}\`)) ENGINE=InnoDB COMMENT='AUTO_INCREMENT=123'${suffix}`;
    if (after && state.changeDdl) value = state.changeDdl(name, value);
    return value;
  };
  const connection = {
    async execute(sql, params = []) {
      state.calls.push({ method: 'execute', sql, params });
      if (state.failRead?.(sql)) throw new Error(secret + ' raw SQL host password');
      if (sql.includes('FROM information_schema.TABLES')) {
        const after = state.metadataReads++ > 0;
        return [names.filter(name => name !== state.omitTable).map(name => ({ TABLE_NAME: name,
          TABLE_TYPE: state.viewTable === name ? 'VIEW' : 'BASE TABLE',
          AUTO_INCREMENT: name === marker || keyFor(name) === 'ingest_event_id' ? null : after ? state.afterCounter : state.beforeCounter })), []];
      }
      if (sql.includes('FROM information_schema.COLUMNS')) return [names.flatMap(name => columnsFor(name)
        .filter(column => !(state.omitColumn && name === names[0] && column === 'vendor'))
        .map((column, index) => ({ TABLE_NAME: name, COLUMN_NAME: column, ORDINAL_POSITION: index + 1,
          COLUMN_KEY: column === keyFor(name) ? 'PRI' : '', EXTRA: column === 'created_at' ? 'DEFAULT_GENERATED' : '' }))), []];
      if (sql.startsWith('SELECT DATE_FORMAT(NOW(6)')) return [[{ snapshot_at: state.clock }], []];
      const name = /FROM `(?:test|fingerprint)`\.`([^`]+)` AS OF TIMESTAMP/.exec(sql)?.[1];
      if (!name || !rowsByTable.has(name)) throw new Error('Unexpected synthetic read query');
      const rows = rowsByTable.get(name);
      if (sql.startsWith('SELECT COUNT(*)')) {
        const occurrence = (state.counts.get(name) ?? 0) + 1;
        state.counts.set(name, occurrence);
        const value = state.countOverride?.(name, occurrence, rows.length) ?? String(rows.length);
        return [[{ row_count: value }], []];
      }
      let candidates = params.length ? rows.filter(row => name === marker
        ? row.instance_id > params[0] : BigInt(row[keyFor(name)]) > BigInt(params[0])) : rows;
      if (state.pageOverride) candidates = state.pageOverride(name, candidates);
      return [candidates.slice(0, 500), []];
    },
    async query(sql) {
      state.calls.push({ method: 'query', sql, params: [] });
      const name = /^SHOW CREATE TABLE `(?:test|fingerprint)`\.`([^`]+)`$/.exec(sql)?.[1];
      if (!name || !names.includes(name)) throw new Error('Unexpected synthetic SHOW query');
      const reads = state.ddlReads.get(name) ?? 0;
      state.ddlReads.set(name, reads + 1);
      return [[{ Table: name, 'Create Table': ddl(name, reads > 0) }], []];
    }
  };
  return { state, run: (options = {}) => exportBiometricBackup({ connection,
    schema: destination ? 'fingerprint' : 'test', purpose: destination ? 'destination' : 'source',
    writeRowsFile: async (name, encoded) => { state.files.set(name, { encoded, callCount: state.calls.length }); },
    waitFn: async milliseconds => { state.waits.push(milliseconds); }, ...options }) };
}

const safeFailure = (code, stage) => error => {
  assert.equal(error.code, `BIOMETRIC_BACKUP_EXPORT_${code}`);
  if (stage) assert.equal(error.stage, stage);
  assert.equal(error.cause, undefined);
  assert.equal((error.stack + JSON.stringify(error)).includes(secret), false);
  return true;
};

test('source export uses only SELECT/SHOW, one fixed snapshot and ordered keyset pages without changing values', async () => {
  const f = fixture({ pageRows: 501 });
  const manifest = await f.run();
  assert.equal(manifest.format, 'biometric-backup-v1');
  assert.equal(manifest.purpose, 'source');
  assert.equal(manifest.schema, 'test');
  assert.equal(manifest.snapshotAt, snapshotAt);
  assert.equal(manifest.consistentSnapshot, true);
  assert.deepEqual(manifest.tables.map(table => table.name), MIGRATION_TABLES);
  assert.deepEqual(f.state.waits, [3000]);
  assert.ok(f.state.calls.every(call => /^(?:SELECT|SHOW CREATE TABLE)\b/.test(call.sql)));
  const snapshotReads = f.state.calls.filter(call => call.sql.includes(' AS OF TIMESTAMP '));
  assert.ok(snapshotReads.every(call => call.sql.includes(` AS OF TIMESTAMP '${snapshotAt}'`)));
  assert.equal(f.state.calls.filter(call => call.sql.includes('NOW(6)')).length, 1);
  assert.equal(f.state.calls.filter(call => call.method === 'query').length, 20);
  assert.ok(f.state.calls.filter(call => call.sql.startsWith('SHOW')).every(call => call.sql.startsWith('SHOW CREATE TABLE `test`.')));
  const devices = manifest.tables[0];
  assert.equal(devices.rowCount, 501);
  assert.equal(devices.maxKey, '9007199254741493');
  assert.equal(devices.autoIncrement, '20');
  assert.match(devices.ddl, /AUTO_INCREMENT=20$/);
  const deviceReads = snapshotReads.filter(call => call.sql.includes('`biometric_svc_devices`') && !call.sql.startsWith('SELECT COUNT'));
  assert.equal(deviceReads.length, 2);
  assert.match(deviceReads[1].sql, /WHERE `id` > \? ORDER BY `id` ASC LIMIT 500$/);
  assert.deepEqual(deviceReads[1].params, ['9007199254741492']);
  const stored = f.state.files.get(devices.rowsFile);
  const decoded = stored.encoded.map(row => Object.fromEntries(devices.columns.map((column, index) => [column, deserializeRow(row)[index]])));
  assert.deepEqual(decoded, f.state.rowsByTable.get(devices.name));
  assert.equal(devices.rowsSha256, canonicalRowsHash(devices.columns, decoded));
  assert.ok(stored.callCount > f.state.calls.findLastIndex(call => call.method === 'query'));
  const processing = manifest.tables.find(table => table.name === 'biometric_svc_event_processing');
  assert.equal(processing.primaryKey, 'ingest_event_id');
  assert.equal(processing.autoIncrement, null);
  const empty = manifest.tables.find(table => table.name === 'biometric_svc_audit_log');
  assert.equal(empty.rowCount, 0);
  assert.equal(empty.maxKey, null);
  assert.match(empty.rowsSha256, /^[0-9a-f]{64}$/);
});

test('destination backup includes its marker with UUID ordering but no numeric max key or auto increment', async () => {
  const f = fixture({ destination: true });
  const manifest = await f.run({ settleMs: 0 });
  assert.deepEqual(manifest.tables.map(table => table.name), BACKUP_TABLES);
  const identity = manifest.tables.find(table => table.name === marker);
  assert.equal(identity.primaryKey, 'instance_id');
  assert.equal(identity.rowCount, 1);
  assert.equal(identity.autoIncrement, null);
  assert.equal(identity.maxKey, null);
  assert.deepEqual(identity.columns, ['purpose', 'instance_id']);
  assert.ok(f.state.calls.filter(call => call.sql.startsWith('SHOW')).every(call => call.sql.startsWith('SHOW CREATE TABLE `fingerprint`.')));
});

test('standalone destination explicitly backs up ten copied tables without changing source or fixture contracts', async () => {
  const f = fixture();
  const manifest = await f.run({ purpose: 'standalone-destination', schema: 'fingerprint', settleMs: 0 });
  assert.equal(manifest.purpose, 'standalone-destination');
  assert.equal(manifest.schema, 'fingerprint');
  assert.deepEqual(manifest.tables.map(table => table.name), MIGRATION_TABLES);
  assert.equal(manifest.tables.some(table => table.name === marker), false);
  assert.equal(f.state.files.size, 10);
  assert.ok(f.state.calls.every(call => /^(?:SELECT|SHOW CREATE TABLE)\b/.test(call.sql)));
  assert.ok(f.state.calls.filter(call => call.sql.startsWith('SHOW')).every(call => call.sql.startsWith('SHOW CREATE TABLE `fingerprint`.')));
  const invalid = fixture();
  await assert.rejects(invalid.run({ purpose: 'standalone-destination', schema: 'test' }), safeFailure('INPUT_INVALID'));
  assert.equal(invalid.state.calls.length, 0);
});

test('unsafe source targets and incomplete metadata fail before snapshot reads or private writes', async () => {
  for (const options of [{ schema: 'tolanhr' }, { purpose: 'destination' }, { schema: 'fingerprint' },
    { settleMs: -1 }, { waitFn: null }]) {
    const f = fixture();
    await assert.rejects(f.run(options), safeFailure('INPUT_INVALID', 'validate-input'));
    assert.equal(f.state.calls.length, 0);
  }
  for (const overrides of [{ omitTable: MIGRATION_TABLES[0] }, { viewTable: MIGRATION_TABLES[0] }, { omitColumn: true }]) {
    const f = fixture(overrides);
    await assert.rejects(f.run(), error => {
      assert.match(error.code, /^BIOMETRIC_BACKUP_EXPORT_(?:TABLE|COLUMN)_METADATA_INVALID$/);
      return true;
    });
    assert.equal(f.state.calls.some(call => call.sql.includes(' AS OF TIMESTAMP ')), false);
    assert.equal(f.state.files.size, 0);
  }
});

test('malformed clocks and source read errors stop without raw SQL, data or credential messages', async () => {
  const clock = fixture({ clock: "2026-11-09 00:00:00'; SELECT secret" });
  await assert.rejects(clock.run(), safeFailure('SNAPSHOT_INVALID', 'read-clock'));
  assert.equal(clock.state.files.size, 0);
  const source = fixture({ failRead: sql => sql.includes(' AS OF TIMESTAMP ') });
  await assert.rejects(source.run(), safeFailure('FAILED', 'read-snapshot'));
  assert.equal(source.state.files.size, 0);
});

test('count disagreement, unsafe counts and non-increasing page keys prevent backup file publication', async () => {
  const overrides = [
    { countOverride: (name, occurrence, n) => name === MIGRATION_TABLES[0] && occurrence === 2 ? String(n + 1) : String(n) },
    { countOverride: () => '9007199254740992' },
    { pageOverride: (name, rows) => name === MIGRATION_TABLES[0] ? [] : rows },
    { pageRows: 2, pageOverride: (name, rows) => name === MIGRATION_TABLES[0] ? rows.slice().reverse() : rows },
    { pageRows: 2, pageOverride: (name, rows) => name === MIGRATION_TABLES[0] ? [rows[0], rows[0]] : rows }
  ];
  for (const options of overrides) {
    const f = fixture(options);
    await assert.rejects(f.run(), error => {
      assert.match(error.code, /^BIOMETRIC_BACKUP_EXPORT_(?:ROW_COUNT_MISMATCH|ROW_COUNT_INVALID|ROW_ORDER_INVALID)$/);
      return true;
    });
    assert.equal(f.state.files.size, 0);
  }
});

test('real structural DDL changes stop before writes; quoted AUTO_INCREMENT text is never ignored', async () => {
  for (const transform of [
    ddl => ddl.replace('bigint unsigned', 'int unsigned'),
    ddl => ddl.replace("COMMENT='AUTO_INCREMENT=123'", "COMMENT='AUTO_INCREMENT=124'")
  ]) {
    const f = fixture({ changeDdl: (name, ddl) => name === MIGRATION_TABLES[0] ? transform(ddl) : ddl });
    await assert.rejects(f.run(), safeFailure('DDL_CHANGED', 'verify-schema'));
    assert.equal(f.state.files.size, 0);
  }
});
