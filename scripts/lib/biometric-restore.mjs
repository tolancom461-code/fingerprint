import {
  MIGRATION_TABLES, BACKUP_TABLES, backupGeneratedColumns, deserializeRow, canonicalRowsHash, validateTableDdl
} from './biometric-backup-format.mjs';

const MARKER = 'biometric_portal_test_identity';
const RESTORE_SCHEMA = /^biometric_portal_restore_[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const BATCH_SIZE = 50;

// The caller supplies an exclusive target connection and file-reader callback.
// This module owns no source connection, filesystem, credentials or environment.
export async function restoreBiometricBackup({ connection, schema, manifest, readRowsFile } = {}) {
  validateTarget(connection, schema);
  const prepared = await prepareBackup(manifest, readRowsFile);
  await assertSelectedTarget(connection, schema);
  const existing = await targetTables(connection, schema);
  if (existing.length) throw invalid('BIOMETRIC_RESTORE_TARGET_NOT_EMPTY');

  const result = [];
  for (const table of prepared) {
    // DDL is the unqualified, validated SHOW CREATE text, preserving TiDB options.
    await connection.query(table.ddl);
    const qualified = `${identifier(schema)}.${identifier(table.name)}`;
    const columnSql = table.columns.map(identifier).join(',');
    for (let offset = 0; offset < table.values.length; offset += BATCH_SIZE) {
      const batch = table.values.slice(offset, offset + BATCH_SIZE);
      const rowPlaceholders = `(${table.columns.map(() => '?').join(',')})`;
      await connection.execute(`INSERT INTO ${qualified} (${columnSql}) VALUES ${batch.map(() => rowPlaceholders).join(',')}`, batch.flat());
    }
    const verified = await verifyTable(connection, schema, table);
    result.push(verified);
    if (verified.rowCount !== table.rowCount || verified.rowsSha256 !== table.rowsSha256 ||
        !verified.ddlMatches || !verified.autoIncrementSafe) {
      throw invalid('BIOMETRIC_RESTORE_VERIFICATION_FAILED');
    }
  }
  await assertTargetTableSet(connection, schema, prepared);
  return { passed: true, tables: result };
}

export async function verifyBiometricBackup({ connection, schema, manifest, readRowsFile } = {}) {
  validateTarget(connection, schema);
  const prepared = await prepareBackup(manifest, readRowsFile);
  await assertSelectedTarget(connection, schema);
  await assertTargetTableSet(connection, schema, prepared);
  const result = [];
  for (const table of prepared) result.push(await verifyTable(connection, schema, table));
  return {
    passed: result.every((table, index) => table.rowCount === prepared[index].rowCount &&
      table.rowsSha256 === prepared[index].rowsSha256 && table.ddlMatches && table.autoIncrementSafe),
    tables: result,
  };
}

function validateTarget(connection, schema) {
  if (typeof schema !== 'string' || (schema !== 'fingerprint' && !RESTORE_SCHEMA.test(schema))) {
    throw invalid('BIOMETRIC_RESTORE_TARGET_REJECTED');
  }
  if (!connection || typeof connection.execute !== 'function' || typeof connection.query !== 'function') {
    throw invalid('BIOMETRIC_RESTORE_CONNECTION_INVALID');
  }
}

async function prepareBackup(manifest, readRowsFile) {
  if (!manifest || manifest.format !== 'biometric-backup-v1' ||
      !['source', 'destination', 'standalone-destination'].includes(manifest.purpose) ||
      manifest.schema !== (manifest.purpose === 'source' ? 'test' : 'fingerprint') ||
      typeof manifest.snapshotAt !== 'string' || !manifest.snapshotAt ||
      !Array.isArray(manifest.tables) || !manifest.tables.length || typeof readRowsFile !== 'function') {
    throw invalid('BIOMETRIC_RESTORE_MANIFEST_INVALID');
  }
  const fullDirectory = manifest.purpose !== 'destination';
  const allowed = fullDirectory ? MIGRATION_TABLES : BACKUP_TABLES;
  if (manifest.tables.length > allowed.length || (fullDirectory && manifest.tables.length !== allowed.length)) {
    throw invalid('BIOMETRIC_RESTORE_TABLE_SET_INVALID');
  }
  const seen = new Set();
  // Validate every definition before reading files or executing target statements.
  for (const table of manifest.tables) {
    if (!table || !allowed.includes(table.name) || seen.has(table.name) ||
        !Array.isArray(table.columns) || !table.columns.length || table.columns.some(column => !validIdentifier(column)) ||
        new Set(table.columns).size !== table.columns.length || table.rowsFile !== `${table.name}.rows.json` ||
        !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || !HASH.test(table.rowsSha256 ?? '')) {
      throw invalid('BIOMETRIC_RESTORE_TABLE_INVALID');
    }
    const expectedKey = table.name === MARKER ? 'instance_id' : table.name === 'biometric_svc_event_processing' ? 'ingest_event_id' : 'id';
    if (table.primaryKey !== expectedKey || !table.columns.includes(expectedKey) ||
        (table.autoIncrement !== null && (typeof table.autoIncrement !== 'string' || !/^[1-9][0-9]*$/.test(table.autoIncrement))) ||
        (table.name === MARKER && (table.autoIncrement !== null || table.maxKey !== null)) ||
        (table.name !== MARKER && table.maxKey !== null && (typeof table.maxKey !== 'string' || !INTEGER.test(table.maxKey)))) {
      throw invalid('BIOMETRIC_RESTORE_TABLE_INVALID');
    }
    try {
      const generated = backupGeneratedColumns(table.ddl, table.name);
      if (generated.some(column => table.columns.includes(column))) throw invalid('BIOMETRIC_RESTORE_DDL_REJECTED');
    }
    catch { throw invalid('BIOMETRIC_RESTORE_DDL_REJECTED'); }
    seen.add(table.name);
  }
  if (fullDirectory && MIGRATION_TABLES.some(table => !seen.has(table))) throw invalid('BIOMETRIC_RESTORE_TABLE_SET_INVALID');

  // Capture validated definitions before awaiting caller-owned file callbacks.
  const definitions = manifest.tables.map(table => ({ ...table, columns: [...table.columns] }));
  const prepared = [];
  for (const table of definitions) {
    const encoded = await readRowsFile(table.rowsFile);
    if (!Array.isArray(encoded) || encoded.length !== table.rowCount) throw invalid('BIOMETRIC_RESTORE_BACKUP_COUNT_MISMATCH');
    const values = [];
    const rows = [];
    let previousKey = null;
    for (const encodedRow of encoded) {
      let decoded;
      try { decoded = deserializeRow(encodedRow); }
      catch { throw invalid('BIOMETRIC_RESTORE_BACKUP_ROW_INVALID'); }
      if (decoded.length !== table.columns.length) throw invalid('BIOMETRIC_RESTORE_BACKUP_ROW_INVALID');
      const row = Object.fromEntries(table.columns.map((column, index) => [column, decoded[index]]));
      const key = row[table.primaryKey];
      if (table.name === MARKER) {
        if (typeof key !== 'string' || !key || (previousKey !== null && key <= previousKey)) throw invalid('BIOMETRIC_RESTORE_BACKUP_ORDER_INVALID');
        previousKey = key;
      } else {
        if ((typeof key !== 'string' || !INTEGER.test(key)) && !(typeof key === 'number' && Number.isSafeInteger(key) && key >= 0) &&
            !(typeof key === 'bigint' && key >= 0n)) throw invalid('BIOMETRIC_RESTORE_BACKUP_KEY_INVALID');
        const numericKey = BigInt(key);
        if (previousKey !== null && numericKey <= previousKey) throw invalid('BIOMETRIC_RESTORE_BACKUP_ORDER_INVALID');
        previousKey = numericKey;
      }
      values.push(decoded); rows.push(row);
    }
    const maxKey = previousKey === null ? null : String(previousKey);
    if (table.name !== MARKER && maxKey !== table.maxKey) throw invalid('BIOMETRIC_RESTORE_BACKUP_KEY_MISMATCH');
    if (canonicalRowsHash(table.columns, rows) !== table.rowsSha256) throw invalid('BIOMETRIC_RESTORE_BACKUP_HASH_MISMATCH');
    prepared.push({ ...table, values });
  }
  return prepared;
}

async function assertSelectedTarget(connection, schema) {
  const [rows] = await connection.execute('SELECT DATABASE() AS selected_database');
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.selected_database !== schema) {
    throw invalid('BIOMETRIC_RESTORE_DATABASE_MISMATCH');
  }
}

async function targetTables(connection, schema) {
  const [rows] = await connection.execute('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [schema]);
  if (!Array.isArray(rows)) throw invalid('BIOMETRIC_RESTORE_METADATA_INVALID');
  return rows;
}

async function assertTargetTableSet(connection, schema, prepared) {
  const rows = await targetTables(connection, schema);
  const expected = new Set(prepared.map(table => table.name));
  if (rows.length !== expected.size || rows.some(row => row.TABLE_TYPE !== 'BASE TABLE' || !expected.has(row.TABLE_NAME))) {
    throw invalid('BIOMETRIC_RESTORE_TABLE_SET_MISMATCH');
  }
}

async function verifyTable(connection, schema, table) {
  const columns = table.columns.map(identifier).join(',');
  const [rows] = await connection.execute(`SELECT ${columns} FROM ${identifier(schema)}.${identifier(table.name)} ORDER BY ${identifier(table.primaryKey)}`);
  if (!Array.isArray(rows)) throw invalid('BIOMETRIC_RESTORE_READBACK_INVALID');
  let rowsSha256;
  try { rowsSha256 = canonicalRowsHash(table.columns, rows); }
  catch { throw invalid('BIOMETRIC_RESTORE_READBACK_INVALID'); }
  const [createRows] = await connection.query(`SHOW CREATE TABLE ${identifier(schema)}.${identifier(table.name)}`);
  const ddl = Array.isArray(createRows) && createRows.length === 1
    ? Object.entries(createRows[0] ?? {}).find(([key]) => /^create table$/i.test(key))?.[1] : null;
  let ddlMatches = false;
  try {
    validateTableDdl(ddl, table.name);
    ddlMatches = normalizeDdl(table.ddl) === normalizeDdl(ddl);
  } catch { /* A malformed or different definition cannot verify. */ }
  let autoIncrementSafe = true;
  if (table.autoIncrement !== null) {
    const [metadata] = await connection.execute('SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, table.name]);
    const next = Array.isArray(metadata) && metadata.length === 1 ? metadata[0]?.AUTO_INCREMENT : null;
    autoIncrementSafe = (typeof next === 'string' && INTEGER.test(next)) || (typeof next === 'number' && Number.isSafeInteger(next) && next >= 0);
    if (autoIncrementSafe) {
      const minimum = table.maxKey === null ? 1n : BigInt(table.maxKey) + 1n;
      autoIncrementSafe = BigInt(next) >= BigInt(table.autoIncrement) && BigInt(next) >= minimum;
    }
  }
  return { name: table.name, rowCount: rows.length, rowsSha256, ddlMatches, autoIncrementSafe };
}

// Ignore only the volatile counter in a table option, never an AUTO_INCREMENT
// column attribute, quoted literal, or TiDB semantic comment.
function normalizeDdl(sql) {
  let output = '';
  let index = 0;
  let depth = 0;
  let outerClosed = false;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"' || character === '`') {
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === '\\' && character !== '`') { index += 2; continue; }
        if (sql[index++] === character) {
          if (sql[index] === character) { index++; continue; }
          break;
        }
      }
      output += sql.slice(start, index); continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      output += sql.slice(index, end + 2); index = end + 2; continue;
    }
    if (character === '#' || (sql.startsWith('--', index) && /\s/.test(sql[index + 2] ?? ''))) {
      const end = sql.indexOf('\n', index);
      if (end < 0) { output += sql.slice(index); break; }
      output += sql.slice(index, end + 1); index = end + 1; continue;
    }
    if (/\s/.test(character)) { if (!output.endsWith(' ')) output += ' '; index++; continue; }
    if (character === '(') depth++;
    else if (character === ')') { depth--; if (depth === 0) outerClosed = true; }
    if (outerClosed && depth === 0) {
      const counter = /^AUTO_INCREMENT\s*=\s*[0-9]+\b/i.exec(sql.slice(index));
      if (counter && !/[A-Za-z0-9_]/.test(sql[index - 1] ?? '')) {
        output += 'AUTO_INCREMENT=<counter>'; index += counter[0].length; continue;
      }
    }
    output += character; index++;
  }
  return output.trim();
}

function validIdentifier(value) { return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value); }
function identifier(value) { if (!validIdentifier(value)) throw invalid('BIOMETRIC_RESTORE_IDENTIFIER_INVALID'); return `\`${value}\``; }
function invalid(code) { return Object.assign(new Error('The isolated biometric restore could not be verified'), { code }); }
