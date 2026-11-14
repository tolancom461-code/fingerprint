import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreBiometricBackup, verifyBiometricBackup } from '../scripts/lib/biometric-restore.mjs';
import { MIGRATION_TABLES, serializeRow, canonicalRowsHash } from '../scripts/lib/biometric-backup-format.mjs';
import { BIOMETRIC_TABLES } from '../src/infrastructure/storage/biometric-table-names.js';

const marker = 'biometric_portal_test_identity';
const instanceId = '30eb4402-70cf-45e1-a1b8-ed03a8aef7ce';
const schema = 'fingerprint';

function backup({ purpose = 'source', firstTableRows = 1, includeMarker = purpose === 'destination' } = {}) {
  const files = new Map();
  const tables = [...MIGRATION_TABLES, ...(includeMarker ? [marker] : [])].map((name, tableIndex) => {
    if (name === marker) {
      const columns = ['purpose', 'instance_id'];
      const rows = [{ purpose: 'portal-isolated-test-v1', instance_id: instanceId }];
      files.set(`${name}.rows.json`, rows.map(row => serializeRow(row, columns)));
      return { name, columns, primaryKey: 'instance_id', rowsFile: `${name}.rows.json`, rowCount: 1,
        ddl: `CREATE TABLE \`${name}\` (\`purpose\` varchar(64) NOT NULL,\`instance_id\` varchar(36) NOT NULL,PRIMARY KEY (\`instance_id\`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
        rowsSha256: canonicalRowsHash(columns, rows), autoIncrement: null, maxKey: null };
    }
    const key = name === 'biometric_svc_event_processing' ? 'ingest_event_id' : 'id';
    const columns = [key, 'payload', 'updated_at', 'optional_value', 'bytes'];
    const rowCount = tableIndex === 0 ? firstTableRows : 1;
    const rows = Array.from({ length: rowCount }, (_, index) => ({ [key]: (9007199254740993n + BigInt(index)).toString(),
      payload: '{"big":9007199254740993,"text":"نص الاختبار"}', updated_at: '2026-11-09 07:15:00.123456',
      optional_value: index % 2 ? '' : null, bytes: Buffer.from([0, 128, 255]) }));
    const auto = key === 'id';
    const ddl = `CREATE TABLE \`${name}\` (\`${key}\` bigint unsigned NOT NULL${auto ? ' AUTO_INCREMENT' : ''},
      \`payload\` json DEFAULT NULL,\`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      \`optional_value\` varchar(128) DEFAULT NULL,\`bytes\` varbinary(32) DEFAULT NULL,
      PRIMARY KEY (\`${key}\`) /*T![clustered_index] CLUSTERED */
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin${auto ? ' AUTO_INCREMENT=9007199254750000' : ''}`;
    files.set(`${name}.rows.json`, rows.map(row => serializeRow(row, columns)));
    return { name, columns, primaryKey: key, ddl, rowsFile: `${name}.rows.json`, rowCount,
      rowsSha256: canonicalRowsHash(columns, rows), autoIncrement: auto ? '9007199254750000' : null,
      maxKey: rows.length ? rows.at(-1)[key] : null };
  });
  return { manifest: { format: 'biometric-backup-v1', purpose, schema: purpose === 'source' ? 'test' : 'fingerprint',
    snapshotAt: '2026-11-09 07:15:00.123456', tables }, files, readRowsFile: async file => files.get(file) };
}

function target(fixture, { selected = schema, existing = [] } = {}) {
  const state = { calls: [], tables: new Map(), definitions: new Map(), counters: new Map(),
    existing, mutateRead: null, mutateDdl: null, lowCounter: false };
  const definitions = new Map(fixture.manifest.tables.map(table => [table.name, table]));
  const connection = {
    async execute(sql, params = []) {
      state.calls.push({ method: 'execute', sql, params });
      if (sql === 'SELECT DATABASE() AS selected_database') return [[{ selected_database: selected }], []];
      if (sql.startsWith('SELECT TABLE_NAME,TABLE_TYPE')) return [[...state.existing,
        ...[...state.tables.keys()].map(TABLE_NAME => ({ TABLE_NAME, TABLE_TYPE: 'BASE TABLE' }))], []];
      if (sql.startsWith('SELECT AUTO_INCREMENT')) {
        return [[{ AUTO_INCREMENT: state.lowCounter ? '1' : state.counters.get(params[1]) }], []];
      }
      if (sql.startsWith('INSERT INTO')) {
        const name = /^INSERT INTO `[^`]+`\.`([^`]+)`/.exec(sql)?.[1];
        assert.ok(definitions.has(name), 'only fixture tables can be inserted');
        const table = definitions.get(name);
        for (let offset = 0; offset < params.length; offset += table.columns.length) {
          state.tables.get(name).push(Object.fromEntries(table.columns.map((column, index) => [column, params[offset + index]])));
        }
        return [{ affectedRows: params.length / table.columns.length }, []];
      }
      const name = / FROM `[^`]+`\.`([^`]+)` ORDER BY /.exec(sql)?.[1];
      assert.ok(name, 'unexpected SQL in the target fixture');
      const rows = state.tables.get(name) ?? [];
      return [state.mutateRead ? state.mutateRead(name, rows) : rows, []];
    },
    async query(sql) {
      state.calls.push({ method: 'query', sql });
      if (sql.startsWith('CREATE TABLE')) {
        const name = /^CREATE TABLE `([^`]+)`/.exec(sql)?.[1];
        assert.ok(name && definitions.has(name));
        state.tables.set(name, []); state.definitions.set(name, sql);
        state.counters.set(name, definitions.get(name).autoIncrement);
        return [{ affectedRows: 0 }, []];
      }
      const name = /^SHOW CREATE TABLE `[^`]+`\.`([^`]+)`$/.exec(sql)?.[1];
      assert.ok(name, 'unexpected target query');
      const ddl = state.mutateDdl ? state.mutateDdl(name, state.definitions.get(name)) : state.definitions.get(name);
      return [[{ Table: name, 'Create Table': ddl }], []];
    },
  };
  return { connection, state };
}

function args(fixture, destination, targetSchema = schema) {
  return { connection: destination.connection, schema: targetSchema, manifest: fixture.manifest, readRowsFile: fixture.readRowsFile };
}

test('source schema and other unapproved targets are rejected before any SQL or file reads', async () => {
  const fixture = backup(); const destination = target(fixture);
  for (const name of ['test', 'Test', 'other', 'fingerprint;DROP DATABASE test', 'fingerprint ', 'biometric_portal_restore_bad']) {
    await assert.rejects(restoreBiometricBackup(args(fixture, destination, name)), { code: 'BIOMETRIC_RESTORE_TARGET_REJECTED' });
    await assert.rejects(verifyBiometricBackup(args(fixture, destination, name)), { code: 'BIOMETRIC_RESTORE_TARGET_REJECTED' });
  }
  assert.deepEqual(destination.state.calls, []);
});

test('the selected target must match and an occupied schema is never changed', async () => {
  const fixture = backup();
  const wrong = target(fixture, { selected: 'test' });
  await assert.rejects(restoreBiometricBackup(args(fixture, wrong)), { code: 'BIOMETRIC_RESTORE_DATABASE_MISMATCH' });
  assert.equal(wrong.state.calls.length, 1);
  const occupied = target(fixture, { existing: [{ TABLE_NAME: 'do_not_touch', TABLE_TYPE: 'BASE TABLE' }] });
  await assert.rejects(restoreBiometricBackup(args(fixture, occupied)), { code: 'BIOMETRIC_RESTORE_TARGET_NOT_EMPTY' });
  assert.equal(occupied.state.calls.every(call => call.sql.startsWith('SELECT')), true);
});

test('a corrupt backup hash in the last file stops before creating any table', async () => {
  const fixture = backup(); const destination = target(fixture);
  fixture.manifest.tables.at(-1).rowsSha256 = '0'.repeat(64);
  await assert.rejects(restoreBiometricBackup(args(fixture, destination)), { code: 'BIOMETRIC_RESTORE_BACKUP_HASH_MISMATCH' });
  assert.deepEqual(destination.state.calls, []);
});

test('validated definitions are captured before awaiting a caller-owned file callback', async () => {
  const fixture = backup(); const destination = target(fixture);
  const originalDdl = fixture.manifest.tables[0].ddl;
  const readRowsFile = async file => {
    fixture.manifest.tables[0].ddl = 'DROP DATABASE test';
    return fixture.files.get(file);
  };
  assert.equal((await restoreBiometricBackup({ ...args(fixture, destination), readRowsFile })).passed, true);
  assert.equal(destination.state.definitions.get(fixture.manifest.tables[0].name), originalDdl);
  assert.equal(destination.state.calls.some(call => call.sql === 'DROP DATABASE test'), false);
});

test('malicious DDL, unowned source tables and unsafe filenames are rejected before writes', async () => {
  for (const change of [table => { table.ddl = table.ddl.replace('CREATE TABLE `', 'CREATE TABLE `test`.`'); },
    table => { table.ddl += ';DROP DATABASE test'; }, table => { table.rowsFile = '../private.rows.json'; },
    table => { table.name = marker; }]) {
    const fixture = backup(); const destination = target(fixture);
    change(fixture.manifest.tables[0]);
    await assert.rejects(restoreBiometricBackup(args(fixture, destination)), error => /^BIOMETRIC_RESTORE_/.test(error.code));
    assert.deepEqual(destination.state.calls, []);
  }
});

test('restoration batches fifty rows, includes every column and preserves typed source values and TiDB DDL', async () => {
  const fixture = backup({ firstTableRows: 101 }); const destination = target(fixture);
  const report = await restoreBiometricBackup(args(fixture, destination));
  assert.equal(report.passed, true);
  assert.equal(report.tables.length, 10);
  assert.equal(destination.state.tables.has(marker), false);
  const firstName = fixture.manifest.tables[0].name;
  const writes = destination.state.calls.filter(call => call.sql.startsWith(`INSERT INTO \`fingerprint\`.\`${firstName}\``));
  assert.deepEqual(writes.map(call => call.params.length / 5), [50, 50, 1]);
  assert.match(writes[0].sql, /\(`id`,`payload`,`updated_at`,`optional_value`,`bytes`\) VALUES/);
  assert.equal(writes[0].params[0], '9007199254740993');
  assert.equal(writes[0].params[1], '{"big":9007199254740993,"text":"نص الاختبار"}');
  assert.equal(writes[0].params[2], '2026-11-09 07:15:00.123456');
  assert.equal(writes[0].params[3], null);
  assert.deepEqual(writes[0].params[4], Buffer.from([0, 128, 255]));
  assert.equal(writes[0].params[8], '');
  assert.equal(destination.state.definitions.get(firstName), fixture.manifest.tables[0].ddl);
  assert.equal(destination.state.calls.some(call => /\b(?:DROP|REPLACE|UPSERT|UPDATE|SET|USE|START|LOCK)\b/i.test(call.sql.split('CREATE TABLE')[0])), false);
  assert.equal(destination.state.calls[0].sql, 'SELECT DATABASE() AS selected_database');
});

test('destination backup can restore its explicit marker and uses its UUID ordering key', async () => {
  const fixture = backup({ purpose: 'destination' }); const destination = target(fixture);
  const report = await restoreBiometricBackup(args(fixture, destination));
  assert.equal(report.tables.length, 11);
  assert.equal(destination.state.tables.get(marker)[0].instance_id, instanceId);
  assert.equal(destination.state.calls.some(call => call.sql === 'SELECT `purpose`,`instance_id` FROM `fingerprint`.`biometric_portal_test_identity` ORDER BY `instance_id`'), true);
});

test('standalone destination restore preserves generated PIN DDL and inserts only the writable snapshot values', async () => {
  const fixture = backup({ purpose: 'standalone-destination' });
  const name = BIOMETRIC_TABLES.deviceUsers;
  const table = fixture.manifest.tables.find(row => row.name === name);
  table.ddl = table.ddl.replace('PRIMARY KEY', "`current_device_user_id` varchar(128) GENERATED ALWAYS AS (CASE WHEN `status`='absent_from_device' THEN NULL ELSE `device_user_id` END) VIRTUAL, PRIMARY KEY");
  const destination = target(fixture);
  assert.equal((await restoreBiometricBackup(args(fixture, destination))).passed, true);
  assert.equal(destination.state.definitions.get(name), table.ddl);
  assert.equal(destination.state.calls.filter(call => call.sql.startsWith('INSERT')).some(call => call.sql.includes('current_device_user_id')), false);
  assert.equal((await verifyBiometricBackup(args(fixture, destination))).passed, true);

  table.columns.push('current_device_user_id');
  const invalidTarget = target(fixture);
  await assert.rejects(restoreBiometricBackup(args(fixture, invalidTarget)), { code: 'BIOMETRIC_RESTORE_DDL_REJECTED' });
  assert.deepEqual(invalidTarget.state.calls, []);
});

test('a standalone destination manifest must include exactly the ten biometric tables', async () => {
  for (const upsert of [fixture => fixture.manifest.tables.pop(), fixture => fixture.manifest.tables.push(backup({ purpose: 'destination' }).manifest.tables.at(-1))]) {
    const fixture = backup({ purpose: 'standalone-destination' });
    upsert(fixture);
    const destination = target(fixture);
    await assert.rejects(restoreBiometricBackup(args(fixture, destination)), { code: 'BIOMETRIC_RESTORE_TABLE_SET_INVALID' });
    assert.deepEqual(destination.state.calls, []);
  }
});

test('a temporary restore schema is allowed only when the selected database matches it', async () => {
  const name = 'biometric_portal_restore_aabbccddeeff';
  const fixture = backup(); const destination = target(fixture, { selected: name });
  assert.equal((await restoreBiometricBackup(args(fixture, destination, name))).passed, true);
  assert.equal(destination.state.calls.filter(call => call.sql.startsWith('INSERT')).every(call => call.sql.startsWith(`INSERT INTO \`${name}\`.`)), true);
});

test('row ordering, duplicate keys, maxKey and encoded-row corruption fail before any target writes', async () => {
  for (const change of [
    fixture => { fixture.files.get(fixture.manifest.tables[0].rowsFile).reverse(); },
    fixture => { const rows = fixture.files.get(fixture.manifest.tables[0].rowsFile); rows[1] = rows[0]; },
    fixture => { fixture.manifest.tables[0].maxKey = '1'; },
    fixture => { fixture.files.get(fixture.manifest.tables[0].rowsFile)[0][0] = { type: 'bad', value: '1' }; }
  ]) {
    const fixture = backup({ firstTableRows: 2 }); const destination = target(fixture);
    change(fixture);
    await assert.rejects(restoreBiometricBackup(args(fixture, destination)), error => /^BIOMETRIC_RESTORE_BACKUP_/.test(error.code));
    assert.deepEqual(destination.state.calls, []);
  }
});

test('restoration stops before the next table when immediate readback does not match the backup', async () => {
  const fixture = backup(); const destination = target(fixture);
  destination.state.mutateRead = (_name, rows) => rows.map(row => ({ ...row, optional_value: 'changed' }));
  await assert.rejects(restoreBiometricBackup(args(fixture, destination)), { code: 'BIOMETRIC_RESTORE_VERIFICATION_FAILED' });
  assert.equal(destination.state.tables.size, 1);
});

test('verification is read-only and reports exact row mismatches without exposing rows', async () => {
  const fixture = backup(); const destination = target(fixture);
  await restoreBiometricBackup(args(fixture, destination));
  const start = destination.state.calls.length;
  destination.state.mutateRead = (_name, rows) => rows.map(row => ({ ...row, updated_at: '2026-11-09 07:15:00.123457' }));
  const report = await verifyBiometricBackup(args(fixture, destination));
  assert.equal(report.passed, false);
  assert.equal(report.tables[0].rowsSha256 === fixture.manifest.tables[0].rowsSha256, false);
  assert.deepEqual(Object.keys(report.tables[0]).sort(), ['autoIncrementSafe', 'ddlMatches', 'name', 'rowCount', 'rowsSha256']);
  assert.equal(destination.state.calls.slice(start).every(call => /^(?:SELECT|SHOW CREATE TABLE)\b/.test(call.sql)), true);
});

test('DDL comparison ignores only table counters, preserving semantic comments, attributes and quoted literals', async () => {
  const fixture = backup(); const destination = target(fixture);
  await restoreBiometricBackup(args(fixture, destination));
  destination.state.mutateDdl = (_name, ddl) => ddl.replace(/AUTO_INCREMENT=\d+/, 'AUTO_INCREMENT=9007199254760000');
  assert.equal((await verifyBiometricBackup(args(fixture, destination))).passed, true);
  destination.state.mutateDdl = (_name, ddl) => ddl.replace('CLUSTERED */', 'NONCLUSTERED */');
  let report = await verifyBiometricBackup(args(fixture, destination));
  assert.equal(report.passed, false); assert.equal(report.tables[0].ddlMatches, false);
  destination.state.mutateDdl = (_name, ddl) => ddl.replace(' ON UPDATE CURRENT_TIMESTAMP(6)', '');
  report = await verifyBiometricBackup(args(fixture, destination));
  assert.equal(report.tables[0].ddlMatches, false);
});

test('a regressed or missing AUTO_INCREMENT is reported as unsafe while a higher allocator value verifies', async () => {
  const fixture = backup(); const destination = target(fixture);
  await restoreBiometricBackup(args(fixture, destination));
  destination.state.lowCounter = true;
  let report = await verifyBiometricBackup(args(fixture, destination));
  assert.equal(report.passed, false); assert.equal(report.tables[0].autoIncrementSafe, false);
  destination.state.lowCounter = false;
  destination.state.counters.set(fixture.manifest.tables[0].name, '9007199254760000');
  report = await verifyBiometricBackup(args(fixture, destination));
  assert.equal(report.passed, true);
});

test('AUTO_INCREMENT-like text inside a quoted comment remains part of the definition comparison', async () => {
  const fixture = backup();
  fixture.manifest.tables[0].ddl = fixture.manifest.tables[0].ddl.replace('ENGINE=InnoDB', "ENGINE=InnoDB COMMENT='AUTO_INCREMENT=17'");
  const destination = target(fixture);
  await restoreBiometricBackup(args(fixture, destination));
  destination.state.mutateDdl = (_name, ddl) => ddl.replace("COMMENT='AUTO_INCREMENT=17'", "COMMENT='AUTO_INCREMENT=18'");
  const report = await verifyBiometricBackup(args(fixture, destination));
  assert.equal(report.passed, false);
  assert.equal(report.tables[0].ddlMatches, false);
});

test('verification rejects extra tables rather than silently accepting a source clone containing a marker', async () => {
  const fixture = backup(); const destination = target(fixture);
  await restoreBiometricBackup(args(fixture, destination));
  destination.state.existing.push({ TABLE_NAME: marker, TABLE_TYPE: 'BASE TABLE' });
  await assert.rejects(verifyBiometricBackup(args(fixture, destination)), { code: 'BIOMETRIC_RESTORE_TABLE_SET_MISMATCH' });
});
