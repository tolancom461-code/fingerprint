// Default is a read-only plan. Apply provisions a new ten-table SELECT account;
// it never creates, modifies or deletes data tables or accesses the source DB.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { BIOMETRIC_TABLES } from '../src/infrastructure/storage/biometric-table-names.js';
import { assertBiometricDatabaseReady } from '../src/infrastructure/database/schema-check.js';
import { createReadOnlyDatabase } from '../src/infrastructure/database/read-only-database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseName = 'fingerprint';
const tables = Object.freeze(Object.values(BIOMETRIC_TABLES));
const defaultFiles = Object.freeze({
  async exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
  async writeExclusive(file, text) { await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 }); },
  async writeReport(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
});

export async function prepareStandaloneReader({ env = process.env, apply = false,
  createConnection = mysql.createConnection, verifyReader = verifyRuntimeReader,
  fileStore = defaultFiles, privateEnvPath = path.join(root, '.env.portal-database.tidb'),
  reportPath = path.join(root, 'verification', 'standalone-reader-setup-2026-11-09.json'),
  connectTimeoutMs = 6000, queryTimeoutMs = 5000 } = {}) {
  const report = { startedAtUtc: new Date().toISOString(), mode: apply ? 'apply' : 'plan',
    passed: false, profile: 'standalone-readonly', destination: databaseName,
    changesApplied: false, dataTablesChanged: false, sourceConnectionsOpened: 0,
    partialProvisioningPossible: false, privateEnvWritten: false,
    completedOperations: [], attemptedOperations: [], cleanup: {} };
  let connection;
  let stage = 'validate-input';
  let activeOperation = null;
  const query = (sql, params = [], method = 'execute') => bounded(
    Promise.resolve().then(() => connection[method]({ sql, timeout: queryTimeoutMs }, params)),
    queryTimeoutMs, () => connection.destroy(), 'STANDALONE_READER_QUERY_TIMEOUT');
  const inspectTables = async () => {
    const [selected] = await query('SELECT DATABASE() AS current_database');
    if (!Array.isArray(selected) || selected.length !== 1 || selected[0]?.current_database !== databaseName) {
      throw failure('STANDALONE_READER_TARGET_MISMATCH');
    }
    const [rows] = await query('SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [databaseName]);
    if (!Array.isArray(rows) || rows.length !== tables.length ||
        new Set(rows.map(row => row?.TABLE_NAME)).size !== tables.length ||
        rows.some(row => row?.TABLE_TYPE !== 'BASE TABLE' || !tables.includes(row.TABLE_NAME))) {
      throw failure('STANDALONE_READER_TABLE_SET_REJECTED');
    }
  };
  const mutate = async (name, sql) => {
    activeOperation = name;
    report.attemptedOperations.push(name);
    report.partialProvisioningPossible = true;
    await query(sql, [], 'query');
    report.completedOperations.push(name);
    report.changesApplied = true;
    activeOperation = null;
  };

  try {
    if (typeof apply !== 'boolean' || typeof createConnection !== 'function' || typeof verifyReader !== 'function' ||
        !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 6000 ||
        !Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 5000 ||
        !fileStore || ['exists', 'writeExclusive', 'writeReport'].some(key => typeof fileStore[key] !== 'function')) {
      throw failure('STANDALONE_READER_INPUT_INVALID');
    }
    const config = configuration(env);
    if (apply && await fileStore.exists(privateEnvPath)) throw failure('STANDALONE_READER_PRIVATE_ENV_EXISTS');
    stage = 'connect-destination-setup';
    let connectionExpired = false;
    connection = await bounded(Promise.resolve().then(() => createConnection({
      host: config.host, port: config.port, user: config.user, password: config.password, database: databaseName,
      connectTimeout: connectTimeoutMs, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
      jsonStrings: true, multipleStatements: false, flags: '-LOCAL_FILES',
      ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true }
    })).then(opened => { if (connectionExpired) opened.destroy(); return opened; }),
    connectTimeoutMs, () => { connectionExpired = true; }, 'STANDALONE_READER_CONNECT_TIMEOUT');

    stage = 'verify-destination-schema';
    await inspectTables();
    await assertBiometricDatabaseReady({ execute: query }, databaseName);
    const [roles] = await query('SELECT CURRENT_ROLE() AS active_roles');
    if (!Array.isArray(roles) || roles.length !== 1 || String(roles[0]?.active_roles ?? '').toUpperCase() !== 'NONE') {
      throw failure('STANDALONE_READER_SETUP_ROLE_REJECTED');
    }
    const [grants] = await query('SHOW GRANTS FOR CURRENT_USER()', [], 'query');
    if (!setupCanCreateAndGrant(grants)) throw failure('STANDALONE_READER_SETUP_PRIVILEGES_REJECTED');
    report.preflight = { selectedDatabaseVerified: true, exactDataTableSetVerified: true,
      schemaContractVerified: true, setupRoleNone: true, setupPrivilegesVerified: true };
    report.plan = { dataTables: tables.length, readerProfile: 'standalone-readonly',
      newReaderAccount: true, readerGrants: 'SELECT on ten named fingerprint tables only',
      operations: ['create-standalone-reader', ...tables.map(table => `grant-reader-select:${table}`)],
      credentialFile: '.env.portal-database.tidb', existingAccountsChanged: false,
      tableOrSourceMutations: false, automaticRollbackOrDeletion: false };
    if (!apply) { report.passed = true; return report; }

    stage = 'recheck-destination';
    await inspectTables();
    const user = `${config.prefix}.fp_view_${randomBytes(4).toString('hex').slice(0, 7)}`;
    const password = `Fp!9aA${randomBytes(32).toString('base64url')}`;
    if (user.length > 32) throw failure('STANDALONE_READER_ACCOUNT_INVALID');
    stage = 'reserve-private-credentials';
    await fileStore.writeExclusive(privateEnvPath, readerEnvironment(config, user, password, connectTimeoutMs, queryTimeoutMs));
    report.privateEnvWritten = true;
    report.completedOperations.push('reserve-private-reader-environment');

    stage = 'create-standalone-reader';
    const account = `'${user}'@'%'`;
    await mutate('create-standalone-reader', `CREATE USER ${account} IDENTIFIED BY '${password}'`);
    stage = 'grant-standalone-reader';
    for (const table of tables) await mutate(`grant-reader-select:${table}`,
      `GRANT SELECT ON \`${databaseName}\`.\`${table}\` TO ${account}`);

    stage = 'verify-runtime-reader';
    await verifyReader({ profile: 'standalone-readonly', host: config.host, port: config.port,
      user, password, database: databaseName, confirmedName: databaseName, sslMode: 'required',
      connectionLimit: 3, connectTimeoutMs, queryTimeoutMs });
    report.readerVerified = true;
    report.partialProvisioningPossible = false;
    report.passed = true;
  } catch (error) {
    report.failure = { stage, code: safeCode(error) };
    report.failedOperation = activeOperation;
    // Keep the generated private file and all completion facts after any partial
    // account/grant operation. Existing users and data are never changed back.
  } finally {
    report.cleanup.setupConnectionClosed = await closeConnection(connection, queryTimeoutMs);
    report.completedAtUtc = new Date().toISOString();
    try { await fileStore.writeReport(reportPath, JSON.stringify(report, null, 2)); }
    catch { report.passed = false; report.reportingFailed = true;
      report.failure ??= { stage: 'write-report', code: 'STANDALONE_READER_REPORT_FAILED' }; }
  }
  return report;
}

async function verifyRuntimeReader(config) {
  const database = await createReadOnlyDatabase(config);
  try { await database.checkReady(); }
  finally { await database.end(); }
}

function configuration(env) {
  if (!env || Object.keys(env).some(key => key.startsWith('TIDB_SOURCE_') && env[key] !== undefined && String(env[key]).length > 0)) {
    throw failure('STANDALONE_READER_SOURCE_CONFIG_REJECTED');
  }
  const host = required(env, 'TIDB_SETUP_HOST');
  const user = required(env, 'TIDB_SETUP_USER');
  const prefix = /^([A-Za-z0-9]{1,16})\.root$/.exec(user)?.[1];
  const port = env.TIDB_SETUP_PORT ?? '4000';
  const password = env.TIDB_SETUP_PASSWORD;
  if (required(env, 'TIDB_SETUP_DATABASE') !== databaseName || !prefix || host.length > 253 || !/^[A-Za-z0-9.-]+$/.test(host) ||
      typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024 ||
      typeof port !== 'string' || !/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw failure('STANDALONE_READER_INPUT_INVALID');
  }
  return { host, user, prefix, password, port: Number(port) };
}

function setupCanCreateAndGrant(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) return false;
  let createUser = false;
  const covered = new Set();
  for (const row of rows) {
    const values = row && typeof row === 'object' ? Object.values(row) : [];
    if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length > 32768) return false;
    const match = /^GRANT\s+(.+?)\s+ON\s+(\*\.\*|`?fingerprint`?\.(?:\*|`?[A-Za-z0-9_]+`?))\s+TO\s+.+?(\s+WITH\s+GRANT\s+OPTION)?$/i.exec(values[0].trim());
    if (!match) continue;
    const privileges = new Set(match[1].toUpperCase().split(/\s*,\s*/).map(value => value.trim().replace(/\s+/g, ' ')));
    const all = privileges.has('ALL PRIVILEGES');
    const scope = match[2].replaceAll('`', '');
    if (scope === '*.*' && (all || privileges.has('CREATE USER'))) createUser = true;
    if (match[3] && (all || privileges.has('SELECT'))) {
      if (scope === '*.*' || scope === 'fingerprint.*') for (const table of tables) covered.add(table);
      else if (tables.includes(scope.slice('fingerprint.'.length))) covered.add(scope.slice('fingerprint.'.length));
    }
  }
  return createUser && covered.size === tables.length;
}

function readerEnvironment(config, user, password, connectTimeoutMs, queryTimeoutMs) {
  const values = { BIOMETRIC_PORTAL_DB_HOST: config.host, BIOMETRIC_PORTAL_DB_PORT: String(config.port),
    BIOMETRIC_PORTAL_DB_USER: user, BIOMETRIC_PORTAL_DB_PASSWORD: password,
    BIOMETRIC_PORTAL_DB_NAME: databaseName, BIOMETRIC_PORTAL_DB_CONFIRMED_NAME: databaseName,
    BIOMETRIC_PORTAL_DB_SSL_MODE: 'required', BIOMETRIC_PORTAL_DB_CONNECT_TIMEOUT_MS: String(connectTimeoutMs),
    BIOMETRIC_PORTAL_DB_QUERY_TIMEOUT_MS: String(queryTimeoutMs) };
  return '# Private generated standalone read-only database account. Never commit or share.\n' +
    Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
}

async function closeConnection(connection, milliseconds) {
  if (!connection) return true;
  try { await bounded(Promise.resolve().then(() => connection.end()), Math.min(milliseconds, 2000), () => connection.destroy(), 'STANDALONE_READER_CLOSE_TIMEOUT'); return true; }
  catch { try { connection.destroy(); } catch {} return false; }
}
function bounded(promise, milliseconds, onTimeout, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { onTimeout(); } catch {} reject(failure(code)); }, milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function required(env, key) { if (typeof env?.[key] !== 'string' || !env[key].trim()) throw failure('STANDALONE_READER_INPUT_INVALID'); return env[key].trim(); }
function failure(code) { return Object.assign(new Error('The standalone read-only account could not be prepared'), { code }); }
function safeCode(error) { return /^(?:STANDALONE_READER_[A-Z0-9_]+|READ_ONLY_DATABASE_[A-Z0-9_]+|ER_[A-Z0-9_]+|E[A-Z0-9_]{1,40})$/.test(error?.code ?? '') ? error.code : 'STANDALONE_READER_FAILED'; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--plan', '--apply'].includes(args[0]))) {
    console.error('STANDALONE_READER_ARGUMENTS_INVALID'); process.exitCode = 1;
  } else {
    const report = await prepareStandaloneReader({ apply: args[0] === '--apply' });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
