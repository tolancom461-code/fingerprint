// NOT FOR PRODUCTION: provisions only the owner's explicitly selected empty
// fingerprint test schema. Default mode is read-only planning.
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { assertBiometricDatabaseReady } from '../src/infrastructure/database/schema-check.js';
import {
  fixtureSchemaOperations, fixtureSeedOperations, fixtureIdentifier,
  FIXTURE_VERSION, FIXTURE_SCHEMA_CHECKSUM, FIXTURE_WARNING, FIXTURE_TABLES,
  FIXTURE_PURPOSE, FIXTURE_MARKER_TABLE, FIXTURE_EVENT_UUID, FIXTURE_EVENT_UTC
} from './test-fixtures/portal-read-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDatabase = 'fingerprint';
const planIdentity = '10000000-0000-4000-8000-000000000001';
const defaultFiles = Object.freeze({
  async exists(file) {
    try { await fs.lstat(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  },
  async writeExclusive(file, text) { await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 }); },
  async writeReport(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
});

export async function setupTiDbTestPortal({ env = process.env, apply = false,
  createConnection = mysql.createConnection, fileStore = defaultFiles,
  privateEnvPath = path.join(root, '.env.readonly-test.tidb'),
  reportPath = path.join(root, 'verification', 'tidb-test-setup-2026-11-09.json'),
  connectTimeoutMs = 6000, queryTimeoutMs = 5000 } = {}) {
  const report = { startedAtUtc: new Date().toISOString(), mode: apply ? 'apply' : 'plan',
    passed: false, changesApplied: false, partialSetupPossible: false,
    warning: FIXTURE_WARNING, fixtureVersion: FIXTURE_VERSION, schemaChecksum: FIXTURE_SCHEMA_CHECKSUM,
    target: targetDatabase, completedOperations: [], attemptedOperations: [], cleanup: {} };
  let setupConnection;
  let readerConnection;
  let stage = 'validate-input';
  let config;
  let activeOperation = null;

  const connect = async settings => {
    let expired = false;
    const pending = Promise.resolve().then(() => createConnection(settings)).then(connection => {
      if (expired) connection.destroy();
      return connection;
    });
    return bounded(pending, connectTimeoutMs, () => { expired = true; }, 'TIDB_SETUP_CONNECT_TIMEOUT');
  };
  const run = (connection, sql, params = [], method = 'execute') => bounded(
    Promise.resolve().then(() => connection[method]({ sql, timeout: queryTimeoutMs }, params)),
    queryTimeoutMs, () => connection.destroy(), 'TIDB_SETUP_QUERY_TIMEOUT');
  const selectedDatabase = async connection => {
    const [rows] = await run(connection, 'SELECT DATABASE() AS current_database');
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.current_database !== targetDatabase) throw coded('TIDB_SETUP_TARGET_MISMATCH');
  };
  const requireEmpty = async () => {
    const [rows] = await run(setupConnection,
      'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [targetDatabase]);
    if (!Array.isArray(rows)) throw coded('TIDB_SETUP_SCHEMA_INSPECTION_INVALID');
    report.preflight = { ...report.preflight, existingTablesOrViews: rows.length };
    if (rows.length !== 0) throw coded('TIDB_SETUP_SCHEMA_NOT_EMPTY');
  };
  const operation = async (name, sql, params = [], method = 'query') => {
    activeOperation = name;
    report.attemptedOperations.push(name);
    report.partialSetupPossible = true;
    await run(setupConnection, sql, params, method);
    report.completedOperations.push(name);
    report.changesApplied = true;
    activeOperation = null;
  };

  try {
    if (typeof apply !== 'boolean' || typeof createConnection !== 'function' ||
        !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 6000 ||
        !Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 5000 ||
        !fileStore || ['exists', 'writeExclusive', 'writeReport'].some(key => typeof fileStore[key] !== 'function')) {
      throw coded('TIDB_SETUP_INPUT_INVALID');
    }
    config = setupConfig(env);
    if (apply && await fileStore.exists(privateEnvPath)) throw coded('TIDB_SETUP_PRIVATE_ENV_EXISTS');
    stage = 'connect-setup-account';
    setupConnection = await connect(connectionOptions(config, connectTimeoutMs));
    stage = 'inspect-empty-target';
    await selectedDatabase(setupConnection);
    await requireEmpty();
    const [roles] = await run(setupConnection, 'SELECT CURRENT_ROLE() AS active_roles');
    if (!Array.isArray(roles) || roles.length !== 1 || String(roles[0]?.active_roles ?? '').toUpperCase() !== 'NONE') {
      throw coded('TIDB_SETUP_ROLE_UNSUPPORTED');
    }
    const [grants] = await run(setupConnection, 'SHOW GRANTS FOR CURRENT_USER()', [], 'query');
    if (!hasSetupPrivileges(grants)) throw coded('TIDB_SETUP_PRIVILEGES_INSUFFICIENT');
    report.preflight = { ...report.preflight, selectedDatabaseVerified: true, setupRoleNone: true, setupPrivilegesVerified: true };
    report.plan = {
      biometricTables: 10, totalTablesIncludingMarker: FIXTURE_TABLES.length,
      syntheticRows: { devices: 1, people: 1, finalEvents: 1, testIdentity: 1 },
      readerAccount: 'new-random-prefixed-account', readerGrants: 'SELECT on eleven named tables only',
      fixtureOperations: [...fixtureSchemaOperations(), ...fixtureSeedOperations(planIdentity)].map(item => item.name),
      additionalOperations: ['create-reader-account', ...FIXTURE_TABLES.map(table => `grant-reader-select:${table}`)],
      credentialFile: '.env.readonly-test.tidb', automaticDeletionOrRollback: false
    };
    if (!apply) { report.passed = true; return report; }

    stage = 'recheck-empty-target';
    await selectedDatabase(setupConnection);
    await requireEmpty();
    const instanceId = randomUUID();
    const readerName = `${config.prefix}.fp_ro_${randomBytes(4).toString('hex')}`;
    const readerPassword = `Fp!9aA${randomBytes(32).toString('base64url')}`;
    if (readerName.length > 32) throw coded('TIDB_SETUP_READER_NAME_INVALID');

    stage = 'reserve-private-credentials';
    await fileStore.writeExclusive(privateEnvPath, serializeReaderEnvironment(config, readerName, readerPassword, instanceId));
    report.privateEnvWritten = true;
    report.completedOperations.push('reserve-private-reader-environment');

    stage = 'apply-synthetic-fixture';
    for (const item of [...fixtureSchemaOperations(), ...fixtureSeedOperations(instanceId)]) {
      await operation(item.name, item.sql, item.params, item.method);
    }
    stage = 'create-reader-account';
    const account = `'${readerName}'@'%'`;
    await operation('create-reader-account', `CREATE USER ${account} IDENTIFIED BY '${readerPassword}'`);
    stage = 'grant-reader-select';
    for (const table of FIXTURE_TABLES) {
      await operation(`grant-reader-select:${table}`,
        `GRANT SELECT ON ${fixtureIdentifier(targetDatabase)}.${fixtureIdentifier(table)} TO ${account}`);
    }

    stage = 'verify-reader-account';
    readerConnection = await connect(connectionOptions({ ...config, user: readerName, password: readerPassword }, connectTimeoutMs));
    await selectedDatabase(readerConnection);
    const [readerRoles] = await run(readerConnection, 'SELECT CURRENT_ROLE() AS active_roles');
    if (!Array.isArray(readerRoles) || readerRoles.length !== 1 || String(readerRoles[0]?.active_roles ?? '').toUpperCase() !== 'NONE') {
      throw coded('TIDB_SETUP_READER_GRANTS_INVALID');
    }
    const [readerGrants] = await run(readerConnection, 'SHOW GRANTS FOR CURRENT_USER()', [], 'query');
    verifyReaderGrants(readerGrants);
    await assertBiometricDatabaseReady({ execute: (sql, params) => run(readerConnection, sql, params) }, targetDatabase);
    const [markers] = await run(readerConnection, `SELECT purpose, instance_id FROM ${fixtureIdentifier(FIXTURE_MARKER_TABLE)}`);
    if (!Array.isArray(markers) || markers.length !== 1 || markers[0]?.purpose !== FIXTURE_PURPOSE || markers[0]?.instance_id !== instanceId) {
      throw coded('TIDB_SETUP_READER_IDENTITY_INVALID');
    }
    const [events] = await run(readerConnection,
      'SELECT final_event_uuid, event_time_utc FROM biometric_svc_final_events WHERE status = ?', ['final']);
    if (!Array.isArray(events) || events.length !== 1 || events[0]?.final_event_uuid !== FIXTURE_EVENT_UUID ||
        String(events[0]?.event_time_utc).replace(' ', 'T') + 'Z' !== FIXTURE_EVENT_UTC) {
      throw coded('TIDB_SETUP_FIXTURE_VERIFICATION_FAILED');
    }
    for (const table of ['biometric_svc_devices', 'biometric_svc_people']) {
      const [counts] = await run(readerConnection, `SELECT COUNT(*) AS total FROM ${fixtureIdentifier(table)}`);
      if (!Array.isArray(counts) || counts.length !== 1 || Number(counts[0]?.total) !== 1) throw coded('TIDB_SETUP_FIXTURE_VERIFICATION_FAILED');
    }
    report.readerVerified = true;
    report.fixtureVerified = true;
    report.partialSetupPossible = false;
    report.passed = true;
  } catch (error) {
    report.failure = { stage, code: safeCode(error) };
    report.failedOperation = activeOperation;
    // Any interrupted DDL/account statement may have completed at the server.
    // Preserve credentials and operation facts; never delete or roll back here.
  } finally {
    report.cleanup.readerConnectionClosed = await closeConnection(readerConnection, queryTimeoutMs);
    report.cleanup.setupConnectionClosed = await closeConnection(setupConnection, queryTimeoutMs);
    report.completedAtUtc = new Date().toISOString();
    try { await fileStore.writeReport(reportPath, JSON.stringify(report, null, 2)); }
    catch {
      report.passed = false;
      report.reportingFailed = true;
      report.failure ??= { stage: 'write-report', code: 'TIDB_SETUP_REPORT_WRITE_FAILED' };
    }
  }
  return report;
}

function setupConfig(env) {
  const host = required(env, 'TIDB_SETUP_HOST');
  const user = required(env, 'TIDB_SETUP_USER');
  const match = /^([A-Za-z0-9]{1,16})\.root$/.exec(user);
  const portText = env.TIDB_SETUP_PORT ?? '4000';
  const password = env.TIDB_SETUP_PASSWORD;
  if (required(env, 'TIDB_SETUP_DATABASE') !== targetDatabase || !match || host.length > 253 ||
      !/^[A-Za-z0-9.-]+$/.test(host) || typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024 ||
      typeof portText !== 'string' || !/^[0-9]+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw coded('TIDB_SETUP_INPUT_INVALID');
  }
  return { host, user, password, prefix: match[1], port: Number(portText), database: targetDatabase };
}

function connectionOptions(config, connectTimeout) {
  return { host: config.host, port: config.port, user: config.user, password: config.password,
    database: targetDatabase, connectTimeout, dateStrings: true, supportBigNumbers: true,
    bigNumberStrings: true, multipleStatements: false, flags: '-LOCAL_FILES',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true } };
}

function hasSetupPrivileges(rows) {
  const global = new Set();
  const schema = new Set();
  let globalGrant = false;
  let schemaGrant = false;
  for (const text of grantStrings(rows)) {
    const match = /^GRANT\s+(.+?)\s+ON\s+(\*\.\*|`fingerprint`\.\*|fingerprint\.\*)\s+TO\s+.+?(\s+WITH\s+GRANT\s+OPTION)?$/i.exec(text);
    if (!match) continue;
    const target = match[2] === '*.*' ? global : schema;
    for (const privilege of match[1].toUpperCase().split(/\s*,\s*/)) target.add(privilege.trim().replace(/\s+/g, ' '));
    if (match[3]) { if (target === global) globalGrant = true; else schemaGrant = true; }
  }
  const grants = (set, privilege) => set.has('ALL PRIVILEGES') || set.has(privilege);
  const scope = privilege => grants(global, privilege) || grants(schema, privilege);
  return scope('CREATE') && scope('INSERT') && scope('SELECT') && grants(global, 'CREATE USER') &&
    ((globalGrant && grants(global, 'SELECT')) || (schemaGrant && grants(schema, 'SELECT')));
}

function verifyReaderGrants(rows) {
  const covered = new Set();
  const accountPart = "(?:'(?:[^'\\\\]|\\\\.|'')*'|`(?:[^`]|``)*`)";
  const account = `${accountPart}\\s*@\\s*${accountPart}`;
  const usage = new RegExp(`^GRANT\\s+USAGE\\s+ON\\s+\\*\\.\\*\\s+TO\\s+${account}$`, 'i');
  const tableGrant = new RegExp(`^GRANT\\s+SELECT\\s+ON\\s+(?:\x60([^\x60]+)\x60|([A-Za-z0-9_$]+))\\.(?:\x60([^\x60]+)\x60|([A-Za-z0-9_$]+))\\s+TO\\s+${account}$`, 'i');
  for (const text of grantStrings(rows)) {
    if (usage.test(text)) continue;
    const match = tableGrant.exec(text);
    const schema = match?.[1] ?? match?.[2];
    const table = match?.[3] ?? match?.[4];
    if (schema !== targetDatabase || !FIXTURE_TABLES.includes(table)) throw coded('TIDB_SETUP_READER_GRANTS_INVALID');
    covered.add(table);
  }
  if (covered.size !== FIXTURE_TABLES.length) throw coded('TIDB_SETUP_READER_GRANTS_INVALID');
}

function grantStrings(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) throw coded('TIDB_SETUP_GRANTS_INVALID');
  return rows.map(row => {
    const fields = row && typeof row === 'object' ? Object.values(row) : [];
    if (fields.length !== 1 || typeof fields[0] !== 'string' || fields[0].length > 32768) throw coded('TIDB_SETUP_GRANTS_INVALID');
    return fields[0].trim();
  });
}

function serializeReaderEnvironment(config, user, password, instanceId) {
  const values = { BIOMETRIC_TEST_DB_HOST: config.host, BIOMETRIC_TEST_DB_PORT: String(config.port),
    BIOMETRIC_TEST_DB_USER: user, BIOMETRIC_TEST_DB_PASSWORD: password,
    BIOMETRIC_TEST_DB_NAME: targetDatabase, BIOMETRIC_TEST_DB_SSL_MODE: 'required',
    BIOMETRIC_TEST_DB_INSTANCE_ID: instanceId, BIOMETRIC_TEST_DB_CONFIRMED_NAME: targetDatabase,
    BIOMETRIC_TEST_DB_CONNECT_TIMEOUT_MS: '6000', BIOMETRIC_TEST_DB_QUERY_TIMEOUT_MS: '5000' };
  return '# Private generated read-only test database connection. Never commit or share.\n' +
    Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
}

async function closeConnection(connection, timeoutMs) {
  if (!connection) return true;
  try { await bounded(Promise.resolve().then(() => connection.end()), Math.min(timeoutMs, 2000), () => connection.destroy(), 'TIDB_SETUP_CLOSE_TIMEOUT'); return true; }
  catch { try { connection.destroy(); } catch {} return false; }
}

function bounded(promise, milliseconds, onTimeout, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { onTimeout(); } catch {} reject(coded(code)); }, milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function required(env, key) { if (typeof env?.[key] !== 'string' || !env[key].trim()) throw coded('TIDB_SETUP_INPUT_INVALID'); return env[key].trim(); }
function coded(code) { return Object.assign(new Error('The isolated TiDB test setup could not be completed'), { code }); }
function safeCode(error) { return /^(?:TIDB_SETUP_[A-Z0-9_]+|ER_[A-Z0-9_]+|E[A-Z0-9_]{1,40})$/.test(error?.code ?? '') ? error.code : 'TIDB_SETUP_FAILED'; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--plan', '--apply'].includes(args[0]))) {
    console.error('TIDB_SETUP_ARGUMENTS_INVALID'); process.exitCode = 1;
  } else {
    const report = await setupTiDbTestPortal({ apply: args[0] === '--apply' });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
}
