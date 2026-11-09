import { setTimeout as delay } from 'node:timers/promises';
import { REQUIRED_BIOMETRIC_COLUMNS } from '../../src/infrastructure/storage/biometric-table-names.js';
import {
  MIGRATION_TABLES, BACKUP_TABLES, canonicalRowsHash, serializeRow, validateTableDdl
} from './biometric-backup-format.mjs';

const MARKER = 'biometric_portal_test_identity';
const PAGE_SIZE = 500;
const SNAPSHOT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const CLOCK_SQL = "SELECT DATE_FORMAT(NOW(6), '%Y-%m-%d %H:%i:%s.%f') AS snapshot_at";

// The caller owns the connection and private file storage. This module sends
// SELECT and SHOW CREATE TABLE only, with one fixed statement-level snapshot.
export async function exportBiometricBackup({ connection, schema, purpose, writeRowsFile,
  settleMs = 3000, waitFn = delay } = {}) {
  let stage = 'validate-input';
  try {
    if (!connection || typeof connection.execute !== 'function' || typeof connection.query !== 'function' ||
        typeof writeRowsFile !== 'function' || typeof waitFn !== 'function' ||
        !Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 30000 ||
        !((purpose === 'source' && schema === 'test') || (purpose === 'destination' && schema === 'fingerprint'))) {
      throw invalid('INPUT_INVALID');
    }
    const names = purpose === 'source' ? MIGRATION_TABLES : BACKUP_TABLES;
    const read = async (sql, params = []) => {
      const result = await connection.execute(sql, params);
      if (!Array.isArray(result) || !Array.isArray(result[0])) throw invalid('READ_RESULT_INVALID');
      return result[0];
    };
    const ddlFor = async table => {
      const result = await connection.query(`SHOW CREATE TABLE ${identifier(schema)}.${identifier(table)}`);
      const rows = result?.[0];
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Table !== table || typeof rows[0]?.['Create Table'] !== 'string') {
        throw invalid('DDL_RESULT_INVALID');
      }
      const ddl = validateTableDdl(rows[0]['Create Table'], table);
      return { ddl, ...ddlStructure(ddl) };
    };

    stage = 'read-metadata';
    const placeholders = names.map(() => '?').join(',');
    const metadataSql = `SELECT TABLE_NAME, TABLE_TYPE, AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders}) ORDER BY TABLE_NAME`;
    const tableRows = await read(metadataSql, [schema, ...names]);
    const tablesBefore = tableMetadata(tableRows, names);
    const columnRows = await read(
      `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders}) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [schema, ...names]);
    const columnsByTable = columnMetadata(columnRows, names);
    const before = new Map();
    for (const name of names) before.set(name, await ddlFor(name));

    stage = 'read-clock';
    const clocks = await read(CLOCK_SQL);
    const snapshotAt = clocks.length === 1 ? clocks[0]?.snapshot_at : null;
    if (typeof snapshotAt !== 'string' || !SNAPSHOT.test(snapshotAt)) throw invalid('SNAPSHOT_INVALID');
    await waitFn(settleMs);

    stage = 'read-snapshot';
    const captured = [];
    for (const name of names) {
      const columns = columnsByTable.get(name);
      const primaryKey = keyFor(name);
      const from = `${identifier(schema)}.${identifier(name)} AS OF TIMESTAMP '${snapshotAt}'`;
      const countSql = `SELECT COUNT(*) AS row_count FROM ${from}`;
      const expected = countValue(await read(countSql));
      const rows = [];
      let lastKey = null;
      while (true) {
        const where = lastKey === null ? '' : ` WHERE ${identifier(primaryKey)} > ?`;
        const page = await read(`SELECT ${columns.map(identifier).join(', ')} FROM ${from}${where} ORDER BY ${identifier(primaryKey)} ASC LIMIT ${PAGE_SIZE}`,
          lastKey === null ? [] : [lastKey]);
        if (page.length > PAGE_SIZE || rows.length + page.length > expected) throw invalid('ROW_COUNT_MISMATCH');
        for (const row of page) {
          // Serialization validates all projected values before they can enter a backup.
          serializeRow(row, columns);
          const key = rowKey(row[primaryKey], primaryKey);
          if (lastKey !== null && !increasing(lastKey, key, primaryKey)) throw invalid('ROW_ORDER_INVALID');
          rows.push(row);
          lastKey = key;
        }
        if (page.length < PAGE_SIZE) break;
      }
      if (rows.length !== expected || countValue(await read(countSql)) !== expected) throw invalid('ROW_COUNT_MISMATCH');
      captured.push({ name, columns, primaryKey, rows, maxKey: name === MARKER ? null : lastKey });
    }

    stage = 'verify-schema';
    const tablesAfter = tableMetadata(await read(metadataSql, [schema, ...names]), names);
    const after = new Map();
    for (const name of names) {
      const definition = await ddlFor(name);
      if (definition.structural !== before.get(name).structural) throw invalid('DDL_CHANGED');
      after.set(name, definition);
    }

    stage = 'write-backup';
    const tables = [];
    for (const { name, columns, primaryKey, rows, maxKey } of captured) {
      const definition = after.get(name);
      const autoIncrement = name === MARKER ? null : maximumCounter([
        tablesBefore.get(name), tablesAfter.get(name), before.get(name).autoIncrement, definition.autoIncrement
      ]);
      const rowsFile = `${name}.rows.json`;
      await writeRowsFile(rowsFile, rows.map(row => serializeRow(row, columns)));
      tables.push({ name, columns, ddl: definition.ddl, rowsFile, rowCount: rows.length,
        rowsSha256: canonicalRowsHash(columns, rows), primaryKey, autoIncrement, maxKey });
    }
    return { format: 'biometric-backup-v1', purpose, schema, snapshotAt, consistentSnapshot: true, tables };
  } catch (error) {
    if (error instanceof BackupExportError) {
      error.stage = stage;
      throw error;
    }
    const failure = invalid('FAILED');
    failure.stage = stage;
    throw failure;
  }
}

function tableMetadata(rows, names) {
  if (rows.length !== names.length) throw invalid('TABLE_METADATA_INVALID');
  const values = new Map();
  for (const row of rows) {
    if (!row || !names.includes(row.TABLE_NAME) || row.TABLE_TYPE !== 'BASE TABLE' || values.has(row.TABLE_NAME) ||
        !Object.hasOwn(row, 'AUTO_INCREMENT')) {
      throw invalid('TABLE_METADATA_INVALID');
    }
    values.set(row.TABLE_NAME, optionalCounter(row.AUTO_INCREMENT));
  }
  return values;
}

function columnMetadata(rows, names) {
  const groups = new Map(names.map(name => [name, []]));
  for (const row of rows) {
    if (!row || !groups.has(row.TABLE_NAME) || typeof row.COLUMN_NAME !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.COLUMN_NAME) ||
        /\b(?:VIRTUAL|STORED)\s+GENERATED\b/i.test(String(row.EXTRA ?? ''))) throw invalid('COLUMN_METADATA_INVALID');
    groups.get(row.TABLE_NAME).push(row);
  }
  const result = new Map();
  for (const [name, metadata] of groups) {
    const columns = metadata.map(row => row.COLUMN_NAME);
    const required = REQUIRED_BIOMETRIC_COLUMNS[name] ?? ['purpose', 'instance_id'];
    const primary = metadata.filter(row => row.COLUMN_KEY === 'PRI').map(row => row.COLUMN_NAME);
    if (!columns.length || new Set(columns).size !== columns.length || required.some(column => !columns.includes(column)) ||
        metadata.some((row, index) => Number(row.ORDINAL_POSITION) !== index + 1) ||
        primary.length !== 1 || primary[0] !== keyFor(name)) throw invalid('COLUMN_METADATA_INVALID');
    result.set(name, columns);
  }
  return result;
}

function keyFor(name) { return name === MARKER ? 'instance_id' : name === 'biometric_svc_event_processing' ? 'ingest_event_id' : 'id'; }
function countValue(rows) {
  if (rows.length !== 1) throw invalid('ROW_COUNT_INVALID');
  const value = counter(rows[0]?.row_count);
  if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('ROW_COUNT_INVALID');
  return Number(value);
}
function rowKey(value, primaryKey) {
  if (primaryKey !== 'instance_id') return counter(value);
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw invalid('ROW_KEY_INVALID');
  }
  return value;
}
function increasing(left, right, primaryKey) { return primaryKey === 'instance_id' ? left < right : BigInt(left) < BigInt(right); }
function counter(value) {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n) return String(value);
  throw invalid('NUMERIC_VALUE_INVALID');
}
function optionalCounter(value) { return value == null ? null : counter(value); }
function maximumCounter(values) {
  const counters = values.filter(value => value !== null);
  return counters.length ? counters.reduce((left, right) => BigInt(left) >= BigInt(right) ? left : right) : null;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw invalid('IDENTIFIER_INVALID');
  return `\`${value}\``;
}

// Remove only an unquoted top-level AUTO_INCREMENT table-option counter. Text
// inside column definitions, quoted defaults, comments and TiDB directives stays exact.
function ddlStructure(ddl) {
  let structural = '';
  let depth = 0;
  let outerClosed = false;
  let autoIncrement = null;
  for (let index = 0; index < ddl.length;) {
    const character = ddl[index];
    if (ddl.startsWith('/*', index)) {
      const end = ddl.indexOf('*/', index + 2);
      if (end < 0) throw invalid('DDL_INVALID');
      structural += ddl.slice(index, end + 2); index = end + 2; continue;
    }
    if (character === '#' || (ddl.startsWith('--', index) && /\s/.test(ddl[index + 2] ?? ''))) {
      const end = ddl.indexOf('\n', index);
      const stop = end < 0 ? ddl.length : end;
      structural += ddl.slice(index, stop); index = stop; continue;
    }
    if (['`', "'", '"'].includes(character)) {
      const start = index++;
      let closed = false;
      while (index < ddl.length) {
        const current = ddl[index++];
        if (current === '\\' && character !== '`') { index++; continue; }
        if (current === character) {
          if (ddl[index] === character) { index++; continue; }
          closed = true; break;
        }
      }
      if (!closed) throw invalid('DDL_INVALID');
      structural += ddl.slice(start, index); continue;
    }
    if (character === '(') depth++;
    if (character === ')' && --depth === 0) outerClosed = true;
    if (depth === 0 && outerClosed && (index === 0 || !/[A-Za-z0-9_]/.test(ddl[index - 1]))) {
      const option = /^AUTO_INCREMENT\s*=\s*([0-9]+)(?![A-Za-z0-9_])/i.exec(ddl.slice(index));
      if (option) {
        if (autoIncrement !== null) throw invalid('DDL_INVALID');
        autoIncrement = counter(option[1]);
        structural = structural.replace(/[ \t]+$/, '');
        index += option[0].length; continue;
      }
    }
    structural += character;
    index++;
  }
  return { structural: structural.trim(), autoIncrement };
}

class BackupExportError extends Error {
  constructor(reason) {
    super('The biometric read-only backup could not be completed');
    this.code = `BIOMETRIC_BACKUP_EXPORT_${reason}`;
  }
}
function invalid(reason) { return new BackupExportError(reason); }
