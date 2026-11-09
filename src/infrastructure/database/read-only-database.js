import mysql from 'mysql2/promise';
import { assertBiometricDatabaseReady } from './schema-check.js';
import { BIOMETRIC_TABLES } from '../storage/biometric-table-names.js';
import { isAllowedTestDatabaseName } from '../../config/test-database-name.js';

const MARKER_TABLE = 'biometric_portal_test_identity';
const MARKER_PURPOSE = 'portal-isolated-test-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIOMETRIC_READ_TABLES = new Set(Object.values(BIOMETRIC_TABLES));
const FIXTURE_READ_TABLES = new Set([...BIOMETRIC_READ_TABLES, MARKER_TABLE]);
const ACCOUNT_PART = "(?:'(?:[^'\\\\]|\\\\.|'')*'|`(?:[^`]|``)*`)";
const ACCOUNT = `${ACCOUNT_PART}\\s*@\\s*${ACCOUNT_PART}`;
const USAGE_GRANT = new RegExp(`^GRANT\\s+USAGE\\s+ON\\s+\\*\\.\\*\\s+TO\\s+${ACCOUNT}$`, 'i');
const TABLE_GRANT = new RegExp(`^GRANT\\s+SELECT\\s+ON\\s+(?:\x60([^\x60]+)\x60|([A-Za-z0-9_$]+))\\.(?:\x60([^\x60]+)\x60|([A-Za-z0-9_$]+))\\s+TO\\s+${ACCOUNT}$`, 'i');

// This is an additional boundary around fixed application queries, not a general
// SQL parser. Database privileges remain the server-enforced read-only boundary.
function assertReadQuery(sql, params) {
  if (typeof sql !== 'string' || sql.length > 100_000 || !/^\s*SELECT\b/i.test(sql) || !Array.isArray(params) ||
      /;|\0|--|#|\/\*|\*\/|:=|@/.test(sql) ||
      /\b(?:INTO|OUTFILE|DUMPFILE|PROCEDURE|LOCK)\b|\bFOR\s+(?:UPDATE|SHARE)\b|\b(?:LOAD_FILE|GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|SLEEP|BENCHMARK|MASTER_POS_WAIT|SOURCE_POS_WAIT|WAIT_FOR_EXECUTED_GTID_SET)\s*\(/i.test(sql)) {
    throw safeError('READ_ONLY_DATABASE_QUERY_REJECTED');
  }
}

export async function createReadOnlyDatabase(config, { createPool = mysql.createPool } = {}) {
  const settings = validateConfig(config);
  let pool;
  try {
    pool = createPool({
      host: settings.host, port: settings.port, user: settings.user, password: settings.password,
      database: settings.database, connectionLimit: settings.connectionLimit,
      connectTimeout: settings.connectTimeoutMs, waitForConnections: true, queueLimit: 10,
      charset: 'utf8mb4_bin', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
      multipleStatements: false, flags: '-LOCAL_FILES', enableKeepAlive: true,
      ssl: settings.sslMode === 'required' ? { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true } : undefined,
    });
  } catch {
    throw safeError('READ_ONLY_DATABASE_UNAVAILABLE');
  }
  let closed = false;
  let ending;
  const operations = new Set();

  function run(sql, params = [], { show = false } = {}) {
    if (closed) return Promise.reject(safeError('READ_ONLY_DATABASE_CLOSED'));
    return new Promise((resolve, reject) => {
      let connection = null;
      let settled = false;
      let timer;
      const operation = { cancel: () => finish(safeError('READ_ONLY_DATABASE_CLOSED'), null, true) };
      operations.add(operation);

      function finish(error, result, destroy = false) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operations.delete(operation);
        if (connection) {
          try { if (destroy) connection.destroy(); else connection.release(); } catch { /* Already closed. */ }
        }
        if (error) reject(error); else resolve(result);
      }

      timer = setTimeout(() => finish(safeError('READ_ONLY_DATABASE_TIMEOUT'), null, true), settings.connectTimeoutMs);
      Promise.resolve().then(() => pool.getConnection()).then(acquired => {
        if (settled) {
          try { acquired.release(); } catch { /* A closed pool owns the connection. */ }
          return;
        }
        connection = acquired;
        clearTimeout(timer);
        timer = setTimeout(() => finish(safeError('READ_ONLY_DATABASE_TIMEOUT'), null, true), settings.queryTimeoutMs);
        Promise.resolve().then(() => show
          ? connection.query({ sql, timeout: settings.queryTimeoutMs })
          : connection.execute({ sql, timeout: settings.queryTimeoutMs }, params)
        ).then(result => finish(null, result), error => {
          const timeout = ['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(error?.code);
          finish(safeError(timeout ? 'READ_ONLY_DATABASE_TIMEOUT' : 'READ_ONLY_DATABASE_UNAVAILABLE'), null, true);
        });
      }, () => finish(safeError('READ_ONLY_DATABASE_UNAVAILABLE')));
    });
  }

  async function end() {
    if (ending) return ending;
    closed = true;
    for (const operation of [...operations]) operation.cancel();
    ending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(safeError('READ_ONLY_DATABASE_CLOSE_TIMEOUT')), settings.connectTimeoutMs);
      Promise.resolve().then(() => pool.end()).then(() => {
        clearTimeout(timer); resolve();
      }, () => {
        clearTimeout(timer); reject(safeError('READ_ONLY_DATABASE_CLOSE_FAILED'));
      });
    });
    return ending;
  }

  async function guard({ schema = false } = {}) {
    const [databaseRows] = await run('SELECT DATABASE() AS current_database');
    if (!Array.isArray(databaseRows) || databaseRows.length !== 1 || databaseRows[0]?.current_database !== settings.database) {
      throw safeError('READ_ONLY_DATABASE_IDENTITY_REJECTED');
    }
    const [roles] = await run('SELECT CURRENT_ROLE() AS active_roles');
    if (!Array.isArray(roles) || roles.length !== 1 || String(roles[0]?.active_roles ?? '').toUpperCase() !== 'NONE') {
      throw safeError('READ_ONLY_DATABASE_GRANTS_REJECTED');
    }
    const [grants] = await run('SHOW GRANTS FOR CURRENT_USER()', [], { show: true });
    assertGrants(grants, settings.database, settings.profile === 'standalone-readonly' ? BIOMETRIC_READ_TABLES : FIXTURE_READ_TABLES);
    if (schema) {
      try { await assertBiometricDatabaseReady({ execute: run }, settings.database); }
      catch (error) {
        if (isSafeError(error)) throw error;
        throw safeError('READ_ONLY_DATABASE_SCHEMA_REJECTED');
      }
    }
    if (settings.profile === 'fixture-readonly') {
      const [markers] = await run(`SELECT purpose, instance_id FROM \`${MARKER_TABLE}\``);
      if (!Array.isArray(markers) || markers.length !== 1 || markers[0]?.purpose !== MARKER_PURPOSE ||
          typeof markers[0]?.instance_id !== 'string' || markers[0].instance_id.toLowerCase() !== settings.instanceId) {
        throw safeError('READ_ONLY_DATABASE_IDENTITY_REJECTED');
      }
    }
    return { ready: true };
  }

  async function checkReady() {
    try { return await guard({ schema: settings.profile === 'standalone-readonly' }); }
    catch (error) {
      if (['READ_ONLY_DATABASE_IDENTITY_REJECTED', 'READ_ONLY_DATABASE_GRANTS_REJECTED'].includes(error?.code)) {
        await end().catch(() => {});
      }
      throw isSafeError(error) ? error : safeError('READ_ONLY_DATABASE_UNAVAILABLE');
    }
  }

  try { await guard({ schema: true }); }
  catch (error) {
    await end().catch(() => {});
    throw isSafeError(error) ? error : safeError('READ_ONLY_DATABASE_UNAVAILABLE');
  }

  return Object.freeze({
    execute(sql, params = []) {
      try { assertReadQuery(sql, params); } catch (error) { return Promise.reject(error); }
      return run(sql, params);
    },
    checkReady,
    end,
  });
}

function assertGrants(rows, database, allowedTables) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) throw safeError('READ_ONLY_DATABASE_GRANTS_REJECTED');
  const covered = new Set();
  for (const row of rows) {
    const values = row && typeof row === 'object' ? Object.values(row) : [];
    if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length > 4096) throw safeError('READ_ONLY_DATABASE_GRANTS_REJECTED');
    const grant = values[0].trim();
    if (USAGE_GRANT.test(grant)) continue;
    const match = TABLE_GRANT.exec(grant);
    if (!match) throw safeError('READ_ONLY_DATABASE_GRANTS_REJECTED');
    const schema = match[1] ?? match[2];
    const table = match[3] ?? match[4];
    // Table-level database names are literals, unlike database-level grant patterns.
    if (schema !== database || !allowedTables.has(table)) throw safeError('READ_ONLY_DATABASE_GRANTS_REJECTED');
    covered.add(table);
  }
  if (covered.size !== allowedTables.size) throw safeError('READ_ONLY_DATABASE_GRANTS_REJECTED');
}

function validateConfig(config) {
  const profile = config?.profile === undefined ? 'fixture-readonly' : config.profile;
  const standalone = profile === 'standalone-readonly';
  const integer = (value, fallback, min, max) => {
    const number = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(number) || number < min || number > max) throw safeError('READ_ONLY_DATABASE_CONFIG_INVALID');
    return number;
  };
  if (!config || !['fixture-readonly', 'standalone-readonly'].includes(profile) ||
      typeof config.host !== 'string' || !config.host.trim() ||
      typeof config.user !== 'string' || !config.user.trim() || typeof config.password !== 'string' || !config.password ||
      !(standalone ? config.database === 'fingerprint' && config.confirmedName === 'fingerprint'
        : isAllowedTestDatabaseName(config.database, config.confirmedName)) ||
      (!standalone && (typeof config.instanceId !== 'string' || !UUID.test(config.instanceId))) ||
      !['required', 'disabled'].includes(config.sslMode) ||
      (config.sslMode === 'disabled' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(config.host))) {
    throw safeError('READ_ONLY_DATABASE_CONFIG_INVALID');
  }
  return {
    profile, host: config.host, user: config.user, password: config.password, database: config.database,
    port: integer(config.port, 4000, 1, 65535), sslMode: config.sslMode,
    instanceId: standalone ? null : config.instanceId.toLowerCase(), connectionLimit: integer(config.connectionLimit, 3, 1, 10),
    connectTimeoutMs: integer(config.connectTimeoutMs, 4000, 1, 30_000),
    queryTimeoutMs: integer(config.queryTimeoutMs, 5000, 1, 30_000),
  };
}

function safeError(code) {
  return Object.assign(new Error('The isolated read-only database operation could not be completed'), { code });
}

function isSafeError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('READ_ONLY_DATABASE_') &&
    error.message === 'The isolated read-only database operation could not be completed';
}
