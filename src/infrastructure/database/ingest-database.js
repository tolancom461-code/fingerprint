import mysql from 'mysql2/promise';
import { BIOMETRIC_TABLES } from '../storage/biometric-table-names.js';
import { assertBiometricDatabaseReady } from './schema-check.js';

const WRITES = new Map([
  [BIOMETRIC_TABLES.devices, ['INSERT', 'UPDATE']], [BIOMETRIC_TABLES.ingestEvents, ['INSERT']],
  [BIOMETRIC_TABLES.eventProcessing, ['INSERT', 'UPDATE']], [BIOMETRIC_TABLES.punches, ['INSERT']],
  [BIOMETRIC_TABLES.deviceUsers, ['INSERT', 'UPDATE']], [BIOMETRIC_TABLES.finalEvents, ['INSERT']],
  [BIOMETRIC_TABLES.finalizationIssues, ['INSERT', 'UPDATE']],
]);
export const INGEST_TABLE_PRIVILEGES = Object.freeze(Object.fromEntries(Object.values(BIOMETRIC_TABLES)
  .map(table => [table, Object.freeze(['SELECT', ...(WRITES.get(table) ?? [])])])));

const METADATA_TABLES = new Set(['COLUMNS', 'TABLES', 'STATISTICS']);
const ACCOUNT_PART = "(?:'(?:[^'\\\\]|\\\\.|'')*'|`(?:[^`]|``)*`)";
const ACCOUNT = `${ACCOUNT_PART}\\s*@\\s*${ACCOUNT_PART}`;
const USAGE_GRANT = new RegExp(`^GRANT\\s+USAGE\\s+ON\\s+\\*\\.\\*\\s+TO\\s+${ACCOUNT}$`, 'i');
const TABLE_GRANT = new RegExp(`^GRANT\\s+([A-Za-z,\\s]+)\\s+ON\\s+(?:\x60([^\x60]+)\x60|([A-Za-z0-9_$]+))\\.(?:\x60([^\x60]+)\x60|([A-Za-z0-9_$]+))\\s+TO\\s+${ACCOUNT}$`, 'i');
const CLAUSES = new Set(['WHERE', 'ON', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'JOIN', 'GROUP', 'ORDER',
  'HAVING', 'LIMIT', 'OFFSET', 'FOR', 'UNION', 'SET', 'VALUES', 'USE', 'FORCE', 'IGNORE', 'PARTITION']);
const SIDE_EFFECTS = new Set(['LOAD_FILE', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'SLEEP', 'BENCHMARK',
  'MASTER_POS_WAIT', 'SOURCE_POS_WAIT', 'WAIT_FOR_EXECUTED_GTID_SET']);

export async function createIngestDatabase(config, { createPool = mysql.createPool } = {}) {
  const settings = settingsFor(config);
  let pool;
  try {
    pool = createPool({ host: settings.host, port: settings.port, user: settings.user, password: settings.password,
      database: 'fingerprint', connectionLimit: settings.connectionLimit, waitForConnections: true, queueLimit: 10,
      connectTimeout: settings.connectTimeoutMs, charset: 'utf8mb4_bin', dateStrings: true, supportBigNumbers: true,
      bigNumberStrings: true, jsonStrings: true, multipleStatements: false, flags: '-LOCAL_FILES', enableKeepAlive: true,
      ssl: settings.sslMode === 'required' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true } : undefined });
  } catch { throw safe('INGEST_DATABASE_UNAVAILABLE'); }

  let closed = false;
  let ending;
  const acquisitions = new Set();
  const leases = new Set();

  async function acquire() {
    if (closed) throw safe('INGEST_DATABASE_CLOSED');
    const raw = await new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => finish(safe('INGEST_DATABASE_CLOSED'));
      acquisitions.add(cancel);
      const timer = setTimeout(() => finish(safe('INGEST_DATABASE_ACQUIRE_TIMEOUT')), settings.connectTimeoutMs);
      function finish(error, connection) {
        if (settled) { if (connection) { try { connection.destroy(); } catch {} } return; }
        settled = true; clearTimeout(timer); acquisitions.delete(cancel);
        if (error) reject(error); else resolve(connection);
      }
      Promise.resolve().then(() => pool.getConnection()).then(connection => finish(null, connection), error => finish(driverError(error)));
    });
    if (closed) { try { raw.destroy(); } catch {} throw safe('INGEST_DATABASE_CLOSED'); }
    return wrap(raw);
  }

  function wrap(raw) {
    let released = false;
    let releaseCode = 'INGEST_DATABASE_CONNECTION_CLOSED';
    let transaction = false;
    let busy = false;
    let cancelOperation = null;
    let leaseTimer;
    const controller = { close: terminate, executeTrusted: (sql, params = [], show = false) => run(() =>
      show ? raw.query({ sql, timeout: settings.queryTimeoutMs }) : raw.execute({ sql, timeout: settings.queryTimeoutMs }, params)) };

    function terminate(code = 'INGEST_DATABASE_CONNECTION_CLOSED') {
      if (released) return;
      released = true; releaseCode = code; transaction = false;
      clearTimeout(leaseTimer); leases.delete(controller);
      const cancel = cancelOperation;
      cancelOperation = null;
      if (cancel) cancel(safe(code));
      try { raw.destroy(); } catch { /* No raw driver errors leave the boundary. */ }
    }

    function run(action) {
      if (released || closed) return Promise.reject(safe(closed ? 'INGEST_DATABASE_CLOSED' : releaseCode));
      if (busy) return Promise.reject(safe('INGEST_DATABASE_CONNECTION_BUSY'));
      busy = true;
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(safe('INGEST_DATABASE_QUERY_TIMEOUT'), null, true), settings.queryTimeoutMs);
        function finish(error, result, discard = false) {
          if (settled) return;
          settled = true; clearTimeout(timer); cancelOperation = null; busy = false;
          if (discard) terminate(error?.code);
          if (error) reject(error); else resolve(result);
        }
        cancelOperation = error => finish(error);
        Promise.resolve().then(action).then(result => finish(null, result), error => {
          const sanitized = driverError(error);
          finish(sanitized, null, sanitized.code !== 'ER_DUP_ENTRY');
        });
      });
    }

    const exposed = Object.freeze({
      execute(sql, params = []) {
        try { assertStatement(sql, params); } catch (error) { return Promise.reject(error); }
        return controller.executeTrusted(sql, params);
      },
      async beginTransaction() {
        if (released || closed) throw safe(closed ? 'INGEST_DATABASE_CLOSED' : releaseCode);
        if (transaction || busy) throw safe('INGEST_DATABASE_TRANSACTION_STATE_INVALID');
        transaction = true;
        await run(() => raw.beginTransaction());
      },
      async commit() {
        if (released || closed) throw safe(closed ? 'INGEST_DATABASE_CLOSED' : releaseCode);
        if (!transaction) throw safe('INGEST_DATABASE_TRANSACTION_STATE_INVALID');
        await run(() => raw.commit());
        transaction = false;
      },
      async rollback() {
        if (released || closed) throw safe(closed ? 'INGEST_DATABASE_CLOSED' : releaseCode);
        if (!transaction) return;
        await run(() => raw.rollback());
        transaction = false;
      },
      release() {
        if (released) return;
        if (transaction || busy) { terminate(); return; }
        released = true; clearTimeout(leaseTimer); leases.delete(controller);
        try { raw.release(); } catch { try { raw.destroy(); } catch {} }
      },
      destroy() { terminate(); },
    });
    controller.exposed = exposed;
    leases.add(controller);
    // Bound the entire lease, including idle time before/between transaction work.
    leaseTimer = setTimeout(() => terminate('INGEST_DATABASE_TRANSACTION_TIMEOUT'), settings.transactionTimeoutMs);
    leaseTimer.unref?.();
    return controller;
  }

  async function end() {
    if (ending) return ending;
    closed = true;
    for (const cancel of [...acquisitions]) cancel();
    for (const lease of [...leases]) lease.close('INGEST_DATABASE_CLOSED');
    ending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(safe('INGEST_DATABASE_CLOSE_TIMEOUT')), settings.connectTimeoutMs);
      Promise.resolve().then(() => pool.end()).then(() => { clearTimeout(timer); resolve(); },
        () => { clearTimeout(timer); reject(safe('INGEST_DATABASE_CLOSE_FAILED')); });
    });
    return ending;
  }

  async function guard() {
    const lease = await acquire();
    try {
      const execute = lease.executeTrusted;
      const [databaseRows] = await execute('SELECT DATABASE() AS current_database');
      if (!Array.isArray(databaseRows) || databaseRows.length !== 1 || databaseRows[0]?.current_database !== 'fingerprint') {
        throw safe('INGEST_DATABASE_IDENTITY_REJECTED');
      }
      const [roles] = await execute('SELECT CURRENT_ROLE() AS active_roles');
      if (!Array.isArray(roles) || roles.length !== 1 || String(roles[0]?.active_roles ?? '').toUpperCase() !== 'NONE') {
        throw safe('INGEST_DATABASE_GRANTS_REJECTED');
      }
      const [grants] = await execute('SHOW GRANTS FOR CURRENT_USER()', [], true);
      assertGrants(grants);
      try { await assertBiometricDatabaseReady({ execute }, 'fingerprint'); }
      catch (error) { if (known(error)) throw error; throw safe('INGEST_DATABASE_SCHEMA_REJECTED'); }
      const [columns] = await execute(
        `SELECT DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [BIOMETRIC_TABLES.eventProcessing, 'automatic_finalization_eligible']);
      if (!Array.isArray(columns) || columns.length !== 1 || String(columns[0]?.DATA_TYPE).toLowerCase() !== 'tinyint' ||
          !/^tinyint(?:\([0-9]+\))?\s+unsigned$/i.test(String(columns[0]?.COLUMN_TYPE)) ||
          String(columns[0]?.IS_NULLABLE).toUpperCase() !== 'NO' || String(columns[0]?.COLUMN_DEFAULT) !== '0') {
        throw safe('INGEST_DATABASE_ELIGIBILITY_SCHEMA_REQUIRED');
      }
      return { ready: true };
    } finally { lease.exposed.release(); }
  }

  async function checkReady() {
    try { return await guard(); }
    catch (error) {
      if (['INGEST_DATABASE_IDENTITY_REJECTED', 'INGEST_DATABASE_GRANTS_REJECTED', 'INGEST_DATABASE_SCHEMA_REJECTED',
        'INGEST_DATABASE_ELIGIBILITY_SCHEMA_REQUIRED'].includes(error?.code)) await end().catch(() => {});
      throw known(error) ? error : safe('INGEST_DATABASE_UNAVAILABLE');
    }
  }

  try { await guard(); }
  catch (error) { await end().catch(() => {}); throw known(error) ? error : safe('INGEST_DATABASE_UNAVAILABLE'); }
  return Object.freeze({
    async execute(sql, params = []) {
      assertStatement(sql, params);
      const lease = await acquire();
      try { return await lease.exposed.execute(sql, params); } finally { lease.exposed.release(); }
    },
    async getConnection() { return (await acquire()).exposed; },
    checkReady,
    end,
  });
}

function assertGrants(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw safe('INGEST_DATABASE_GRANTS_REJECTED');
  const seen = new Map();
  for (const row of rows) {
    const values = row && typeof row === 'object' ? Object.values(row) : [];
    if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length > 8192) throw safe('INGEST_DATABASE_GRANTS_REJECTED');
    const text = values[0].trim();
    if (USAGE_GRANT.test(text)) continue;
    const match = TABLE_GRANT.exec(text);
    const database = match?.[2] ?? match?.[3];
    const table = match?.[4] ?? match?.[5];
    if (!match || database !== 'fingerprint' || !Object.hasOwn(INGEST_TABLE_PRIVILEGES, table)) throw safe('INGEST_DATABASE_GRANTS_REJECTED');
    const allowed = INGEST_TABLE_PRIVILEGES[table];
    for (const privilege of match[1].split(',').map(item => item.trim().toUpperCase())) {
      if (!allowed.includes(privilege)) throw safe('INGEST_DATABASE_GRANTS_REJECTED');
      if (!seen.has(table)) seen.set(table, new Set());
      seen.get(table).add(privilege);
    }
  }
  for (const [table, required] of Object.entries(INGEST_TABLE_PRIVILEGES)) {
    if (seen.get(table)?.size !== required.length || required.some(privilege => !seen.get(table).has(privilege))) {
      throw safe('INGEST_DATABASE_GRANTS_REJECTED');
    }
  }
}

function assertStatement(sql, params) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 100_000 || !Array.isArray(params)) throw safe('INGEST_DATABASE_QUERY_REJECTED');
  const tokens = tokenize(sql);
  const command = word(tokens[0]);
  if (!['SELECT', 'INSERT', 'UPDATE'].includes(command)) throw safe('INGEST_DATABASE_QUERY_REJECTED');
  const references = [];
  const qualifiedDots = new Set();
  const aliases = new Set();
  function reference(index, privilege) {
    const first = identifier(tokens[index]);
    if (!first) throw safe('INGEST_DATABASE_QUERY_REJECTED');
    const qualified = tokens[index + 1]?.value === '.';
    const database = qualified ? first : null;
    const table = qualified ? identifier(tokens[index + 2]) : first;
    if (!table || tokens[index + (qualified ? 3 : 1)]?.value === '.') throw safe('INGEST_DATABASE_QUERY_REJECTED');
    if (database?.toLowerCase() === 'information_schema') {
      if (privilege !== 'SELECT' || !METADATA_TABLES.has(table.toUpperCase())) throw safe('INGEST_DATABASE_QUERY_REJECTED');
    } else if ((database !== null && database !== 'fingerprint') || !INGEST_TABLE_PRIVILEGES[table]?.includes(privilege)) {
      throw safe('INGEST_DATABASE_QUERY_REJECTED');
    }
    if (qualified) qualifiedDots.add(index + 1);
    aliases.add(table.toLowerCase());
    const next = index + (qualified ? 3 : 1);
    const candidate = word(tokens[next]) === 'AS' ? tokens[next + 1] : tokens[next];
    const alias = identifier(candidate);
    if (alias && !CLAUSES.has(alias.toUpperCase()) && alias.toLowerCase() !== 'test') aliases.add(alias.toLowerCase());
    references.push({ table, privilege });
    return next;
  }
  if (command === 'INSERT') {
    if (word(tokens[1]) !== 'INTO') throw safe('INGEST_DATABASE_QUERY_REJECTED');
    const next = reference(2, 'INSERT');
    if (tokens[next]?.value !== '(' || !tokens.some(token => word(token) === 'VALUES')) throw safe('INGEST_DATABASE_QUERY_REJECTED');
  } else if (command === 'UPDATE') {
    if (word(tokens[reference(1, 'UPDATE')]) !== 'SET') throw safe('INGEST_DATABASE_QUERY_REJECTED');
  }
  let depth = 0;
  const fromClauses = new Map();
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    const keyword = word(token);
    if (token.value === '(') depth++;
    if (token.value === ')') { fromClauses.delete(depth); depth--; }
    if (depth < 0) throw safe('INGEST_DATABASE_QUERY_REJECTED');
    if (keyword && (SIDE_EFFECTS.has(keyword) && tokens[index + 1]?.value === '(')) throw safe('INGEST_DATABASE_QUERY_REJECTED');
    if (['DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'REPLACE', 'CALL', 'DO', 'EXECUTE', 'PREPARE',
      'DEALLOCATE', 'LOAD', 'LOCK', 'UNLOCK', 'START', 'COMMIT', 'ROLLBACK', 'ANALYZE', 'OPTIMIZE', 'REPAIR', 'KILL',
      'FLUSH', 'INSTALL', 'UNINSTALL', 'SHUTDOWN', 'PROCEDURE', 'OUTFILE', 'DUMPFILE', 'UNION'].includes(keyword)) {
      throw safe('INGEST_DATABASE_QUERY_REJECTED');
    }
    if (command !== 'SELECT' && keyword === 'SELECT') throw safe('INGEST_DATABASE_QUERY_REJECTED');
    if (command === 'SELECT' && ['INSERT', 'UPDATE', 'INTO', 'SET'].includes(keyword)) throw safe('INGEST_DATABASE_QUERY_REJECTED');
    if (keyword === 'FOR' && ['UPDATE', 'SHARE'].includes(word(tokens[index + 1]))) throw safe('INGEST_DATABASE_QUERY_REJECTED');
    if (command === 'INSERT' && keyword === 'UPDATE') {
      if (word(tokens[index - 3]) !== 'ON' || word(tokens[index - 2]) !== 'DUPLICATE' || word(tokens[index - 1]) !== 'KEY' ||
          !INGEST_TABLE_PRIVILEGES[references[0].table].includes('UPDATE')) throw safe('INGEST_DATABASE_QUERY_REJECTED');
    }
    if (keyword === 'FROM' || keyword === 'JOIN') {
      reference(index + 1, 'SELECT');
      fromClauses.set(depth, true);
    } else if (['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET'].includes(keyword)) fromClauses.delete(depth);
    if (token.value === ',' && fromClauses.get(depth)) throw safe('INGEST_DATABASE_QUERY_REJECTED');
  }
  if (depth !== 0) throw safe('INGEST_DATABASE_QUERY_REJECTED');
  for (let index = 1; index < tokens.length - 1; index++) {
    if (tokens[index].value !== '.' || !identifier(tokens[index - 1]) || !identifier(tokens[index + 1])) continue;
    if (qualifiedDots.has(index)) continue;
    if (!aliases.has(identifier(tokens[index - 1]).toLowerCase()) || tokens[index + 2]?.value === '(') throw safe('INGEST_DATABASE_QUERY_REJECTED');
  }
}

function tokenize(sql) {
  const result = [];
  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    if (/\s/.test(character)) { index++; continue; }
    if (';\0@#'.includes(character) || sql.startsWith('--', index) || sql.startsWith('/*', index) || sql.startsWith('*/', index) || sql.startsWith(':=', index)) {
      throw safe('INGEST_DATABASE_QUERY_REJECTED');
    }
    if (["'", '"', '`'].includes(character)) {
      const quote = character;
      let value = ''; let finished = false; index++;
      while (index < sql.length) {
        const current = sql[index++];
        if (current === quote) { if (sql[index] === quote) { value += quote; index++; continue; } finished = true; break; }
        if (current === '\\' && quote !== '`') { if (index >= sql.length) break; value += sql[index++]; } else value += current;
      }
      if (!finished) throw safe('INGEST_DATABASE_QUERY_REJECTED');
      result.push({ type: quote === '`' ? 'identifier' : 'literal', value }); continue;
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(sql.slice(index));
    if (match) { result.push({ type: 'word', value: match[0] }); index += match[0].length; }
    else { result.push({ type: 'symbol', value: character }); index++; }
  }
  return result;
}

function settingsFor(config) {
  const integer = (value, fallback, maximum) => {
    const number = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw safe('INGEST_DATABASE_CONFIG_INVALID');
    return number;
  };
  if (!config || config.database !== 'fingerprint' || config.confirmedName !== 'fingerprint' ||
      typeof config.host !== 'string' || !config.host.trim() || config.host !== config.host.trim() ||
      typeof config.user !== 'string' || !config.user.trim() || config.user !== config.user.trim() ||
      /(?:^|\.)root$/i.test(config.user) || typeof config.password !== 'string' || !config.password ||
      !['required', 'disabled'].includes(config.sslMode) ||
      (config.sslMode === 'disabled' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(config.host))) {
    throw safe('INGEST_DATABASE_CONFIG_INVALID');
  }
  return { host: config.host, user: config.user, password: config.password, sslMode: config.sslMode,
    port: integer(config.port, 4000, 65535), connectionLimit: integer(config.connectionLimit, 5, 5),
    connectTimeoutMs: integer(config.connectTimeoutMs, 4000, 30000), queryTimeoutMs: integer(config.queryTimeoutMs, 5000, 30000),
    transactionTimeoutMs: integer(config.transactionTimeoutMs, 30000, 60000) };
}

function identifier(token) { return token && ['word', 'identifier'].includes(token.type) ? token.value : null; }
function word(token) { return token?.type === 'word' ? token.value.toUpperCase() : null; }
function safe(code, extra = {}) { return Object.assign(new Error('The guarded biometric database operation could not be completed'), { code, ...extra }); }
function known(error) { return typeof error?.code === 'string' && error.code.startsWith('INGEST_DATABASE_') && error.message === 'The guarded biometric database operation could not be completed'; }
function driverError(error) {
  if (error?.code === 'ER_DUP_ENTRY' || Number(error?.errno) === 1062) return safe('ER_DUP_ENTRY', { errno: 1062 });
  return safe(['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(error?.code) ? 'INGEST_DATABASE_QUERY_TIMEOUT' : 'INGEST_DATABASE_UNAVAILABLE');
}
