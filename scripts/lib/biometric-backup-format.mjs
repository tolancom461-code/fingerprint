import { createHash } from 'node:crypto';
import { BIOMETRIC_TABLES } from '../../src/infrastructure/storage/biometric-table-names.js';

// Only these service-owned tables may enter a source migration. The additional
// marker belongs to the test destination backup and is never a source table.
export const MIGRATION_TABLES = Object.freeze(Object.values(BIOMETRIC_TABLES));
export const BACKUP_TABLES = Object.freeze([...MIGRATION_TABLES, 'biometric_portal_test_identity']);
const DERIVED_DEVICE_USER_PIN = 'current_device_user_id';

export function encodeValue(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString() };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { type: 'number', value: Object.is(value, -0) ? '-0' : value.toString() };
  }
  if (Buffer.isBuffer(value)) return { type: 'buffer', value: value.toString('base64') };
  throw invalid('VALUE_TYPE_UNSUPPORTED');
}

export function decodeValue(encoded) {
  if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(encoded))) throw invalid('ENCODED_VALUE_INVALID');
  const keys = Object.keys(encoded).sort();
  if (encoded.type === 'null') {
    if (keys.length !== 1 || keys[0] !== 'type') throw invalid('ENCODED_VALUE_INVALID');
    return null;
  }
  if (keys.length !== 2 || keys[0] !== 'type' || keys[1] !== 'value') throw invalid('ENCODED_VALUE_INVALID');
  const value = encoded.value;
  if (encoded.type === 'string' && typeof value === 'string') return value;
  if (encoded.type === 'boolean' && typeof value === 'boolean') return value;
  if (encoded.type === 'bigint' && typeof value === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (encoded.type === 'number' && typeof value === 'string') {
    const number = Number(value);
    if (Number.isFinite(number) && (value === '-0' || number.toString() === value)) return number;
  }
  if (encoded.type === 'buffer' && typeof value === 'string' &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    const buffer = Buffer.from(value, 'base64');
    if (buffer.toString('base64') === value) return buffer;
  }
  throw invalid('ENCODED_VALUE_INVALID');
}

export function serializeRow(row, columns) {
  validateColumns(columns);
  if (!row || typeof row !== 'object' || Array.isArray(row) || Buffer.isBuffer(row)) throw invalid('ROW_INVALID');
  return columns.map(column => {
    if (!Object.hasOwn(row, column)) throw invalid('ROW_COLUMN_MISSING');
    return encodeValue(row[column]);
  });
}

export function deserializeRow(encoded) {
  if (!Array.isArray(encoded)) throw invalid('ENCODED_ROW_INVALID');
  return encoded.map(decodeValue);
}

// Rows must be supplied in the same explicit key order at export and verification.
// JSON, SQL dates and BIGINT values configured as driver strings remain exact;
// no JSON parsing, number conversion, timezone inference or row sorting occurs.
export function canonicalRowsHash(columns, rows) {
  validateColumns(columns);
  if (!Array.isArray(rows)) throw invalid('ROWS_INVALID');
  const hash = createHash('sha256');
  hash.update('biometric-backup-rows-v1\n');
  hash.update(JSON.stringify(columns));
  hash.update('\n');
  for (const row of rows) {
    hash.update(JSON.stringify(serializeRow(row, columns)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function validateTableDdl(ddl, expectedTable) {
  validatedDdlTokens(ddl, expectedTable);
  return ddl;
}

// Verify the only derived field excluded from the writable row snapshots. The
// complete column definition remains in the manifest's CREATE TABLE statement.
export function backupGeneratedColumns(ddl, expectedTable) {
  const tokens = validatedDdlTokens(ddl, expectedTable);
  const generated = [];
  let columnStart = 4;
  let depth = 1;
  for (let index = columnStart; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'symbol') continue;
    if (depth === 1 && [',', ')'].includes(token.value)) {
      const definition = tokens.slice(columnStart, index);
      const generatedAt = generatedExpressionStart(definition);
      if (generatedAt !== -1) {
        const column = definition[0]?.value;
        if (expectedTable !== BIOMETRIC_TABLES.deviceUsers || column !== DERIVED_DEVICE_USER_PIN ||
            generated.includes(column) || !matchesDerivedPin(definition, generatedAt)) {
          throw invalid('TABLE_DDL_GENERATED_COLUMN_REJECTED');
        }
        generated.push(column);
      }
      columnStart = index + 1;
    }
    if (token.value === '(') depth++;
    else if (token.value === ')' && --depth === 0) break;
  }
  return generated;
}

function generatedExpressionStart(definition) {
  let depth = 0;
  for (let index = 1; index < definition.length; index++) {
    const token = definition[index];
    if (depth === 0 && word(token, 'AS') && definition[index + 1]?.type === 'symbol' &&
        definition[index + 1].value === '(') return index;
    if (token.type !== 'symbol') continue;
    if (token.value === '(') depth++;
    else if (token.value === ')') depth--;
  }
  return -1;
}

function matchesDerivedPin(definition, generatedAt) {
  const type = definition.slice(1, generatedAt).map(token => token.value.toLowerCase()).join('');
  if (!/^varchar\(128\)(?:charactersetutf8mb4)?(?:collateutf8mb4_bin)?(?:generatedalways)?$/.test(type)) return false;
  const body = definition.slice(generatedAt + 1);
  if (word(body.at(-1), 'VIRTUAL')) body.pop();
  const expression = body.filter(token => !(token.type === 'symbol' && ['(', ')'].includes(token.value)) &&
    !(token.type === 'word' && /^_(?:utf8mb4|utf8mb3|utf8|binary)$/i.test(token.value)));
  return expression.map(token => token.type === 'string' ? `'${token.value}'` : token.value.toLowerCase()).join(' ') ===
    "case when status = 'absent_from_device' then null else device_user_id end";
}

function validatedDdlTokens(ddl, expectedTable) {
  if (typeof ddl !== 'string' || !ddl.trim() || ddl.length > 1_000_000 || !BACKUP_TABLES.includes(expectedTable)) {
    throw invalid('TABLE_DDL_INVALID');
  }
  const tokens = ddlTokens(ddl);
  if (!word(tokens[0], 'CREATE') || !word(tokens[1], 'TABLE') ||
      !['word', 'identifier'].includes(tokens[2]?.type) || tokens[2].value !== expectedTable ||
      tokens[3]?.type !== 'symbol' || tokens[3].value !== '(') throw invalid('TABLE_DDL_TARGET_INVALID');
  let depth = 0;
  let outerClosed = false;
  const forbidden = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME', 'INSERT', 'REPLACE', 'DELETE', 'TRUNCATE',
    'GRANT', 'REVOKE', 'USE', 'SELECT', 'REFERENCES', 'CALL', 'DO', 'EXECUTE', 'PREPARE',
    'DEALLOCATE', 'LOAD', 'LOCK', 'UNLOCK', 'START', 'COMMIT', 'ROLLBACK', 'ANALYZE',
    'OPTIMIZE', 'REPAIR', 'KILL', 'FLUSH', 'BINLOG', 'INSTALL', 'UNINSTALL', 'SHUTDOWN',
    'TABLESPACE', 'CONNECTION', 'UNION', 'FEDERATED']);
  for (let index = 3; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'symbol') {
      if (token.value === '(') depth++;
      else if (token.value === ')') {
        if (--depth < 0) throw invalid('TABLE_DDL_INVALID');
        if (depth === 0) outerClosed = true;
      }
      continue;
    }
    if (token.type !== 'word') continue;
    const keyword = token.value.toUpperCase();
    if (forbidden.has(keyword) || (keyword === 'UPDATE' && !(depth > 0 && word(tokens[index - 1], 'ON'))) ||
        ((keyword === 'LIKE' || keyword === 'AS' || keyword === 'SET' || keyword === 'INTO') && depth === 0) ||
        ((keyword === 'DATA' || keyword === 'INDEX') && word(tokens[index + 1], 'DIRECTORY'))) {
      throw invalid('TABLE_DDL_COMMAND_REJECTED');
    }
  }
  if (!outerClosed || depth !== 0) throw invalid('TABLE_DDL_INVALID');
  return tokens;
}

function ddlTokens(sql, directive = false) {
  const tokens = [];
  const directiveCommands = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME', 'INSERT', 'UPDATE', 'DELETE',
    'REPLACE', 'TRUNCATE', 'GRANT', 'REVOKE', 'USE', 'SELECT', 'SET', 'CALL', 'DO', 'EXECUTE',
    'PREPARE', 'DEALLOCATE', 'LOAD', 'LOCK', 'UNLOCK', 'START', 'COMMIT', 'ROLLBACK',
    'ANALYZE', 'OPTIMIZE', 'REPAIR', 'KILL', 'FLUSH', 'BINLOG', 'INSTALL', 'UNINSTALL', 'SHUTDOWN', 'REFERENCES']);
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (/\s/.test(character)) { index++; continue; }
    if (character === '\0' || character === ';') throw invalid('TABLE_DDL_STATEMENT_REJECTED');
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw invalid('TABLE_DDL_INVALID');
      const content = sql.slice(index + 2, end);
      if (content.includes('/*')) throw invalid('TABLE_DDL_COMMENT_REJECTED');
      if (content.startsWith('!')) throw invalid('TABLE_DDL_COMMENT_REJECTED');
      if (/^T!/i.test(content)) {
        if (directive) throw invalid('TABLE_DDL_COMMENT_REJECTED');
        const match = /^T!(?:\[[A-Za-z0-9_, -]+\])?\s+([\s\S]*)$/i.exec(content);
        if (!match) throw invalid('TABLE_DDL_COMMENT_REJECTED');
        tokens.push(...ddlTokens(match[1], true));
      }
      index = end + 2;
      continue;
    }
    if (character === '#' || (sql.startsWith('--', index) && /\s/.test(sql[index + 2] ?? ''))) {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (character === '`' || character === "'" || character === '"') {
      const quote = character;
      let value = '';
      let closed = false;
      index++;
      while (index < sql.length) {
        const current = sql[index++];
        if (current === quote) {
          if (sql[index] === quote) { value += quote; index++; continue; }
          closed = true; break;
        }
        if (current === '\\' && quote !== '`') {
          if (index >= sql.length) throw invalid('TABLE_DDL_INVALID');
          value += current + sql[index++];
        } else value += current;
      }
      if (!closed) throw invalid('TABLE_DDL_INVALID');
      tokens.push({ type: quote === '`' ? 'identifier' : 'string', value });
      continue;
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(sql.slice(index));
    if (match) {
      const value = match[0];
      if (directive && directiveCommands.has(value.toUpperCase())) throw invalid('TABLE_DDL_COMMAND_REJECTED');
      tokens.push({ type: 'word', value }); index += value.length;
    } else { tokens.push({ type: 'symbol', value: character }); index++; }
  }
  return tokens;
}

function validateColumns(columns) {
  if (!Array.isArray(columns) || !columns.length || columns.some(column => typeof column !== 'string' || !column || column.includes('\0')) ||
      new Set(columns).size !== columns.length) throw invalid('COLUMNS_INVALID');
}

function word(token, expected) { return token?.type === 'word' && token.value.toUpperCase() === expected; }
function invalid(reason) { return Object.assign(new TypeError(`Invalid biometric backup format: ${reason}`), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID', reason }); }
