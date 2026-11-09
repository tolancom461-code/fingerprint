import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { hashPassword } from '../src/infrastructure/portal/auth.js';
import { BIOMETRIC_TABLES } from '../src/infrastructure/storage/biometric-table-names.js';
import { fixtureSchemaOperations, fixtureSeedOperations, fixtureIdentifier as identifier,
  FIXTURE_EVENT_UUID as fixtureUuid, FIXTURE_DEVICE_ID as deviceId, FIXTURE_PERSON_ID as personId,
  FIXTURE_EVENT_UTC } from './test-fixtures/portal-read-fixture.mjs';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultMysqld = 'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqld.exe';

// This harness creates its own empty datadir. It never accepts an existing DB,
// connection URL, production credentials, data directory or target schema.
export async function verifyTestPortalMysql({
  mysqldPath = process.env.BIOMETRIC_TEST_MYSQLD_PATH || defaultMysqld,
  onProgress = value => console.log(`[test-portal-verification] ${value}`)
} = {}) {
  const report = { startedAtUtc: new Date().toISOString(), passed: false,
    fixtureOnly: true, productionDataUsed: false, existingServicesChanged: false,
    databaseEngine: 'MySQL', checks: [], cleanup: {} };
  const verificationDir = path.join(serviceRoot, 'verification');
  await fs.mkdir(verificationDir, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(path.join(verificationDir, 'portal-mysql-test-'));
  const dataDir = path.join(fixtureRoot, 'data');
  const initFile = path.join(fixtureRoot, 'bootstrap.sql');
  const dbName = `biometric_portal_test_${randomBytes(8).toString('hex')}`;
  const instanceId = randomUUID();
  const rootPassword = randomBytes(32).toString('hex');
  const readPassword = randomBytes(32).toString('hex');
  const adminPassword = `Test-${randomBytes(24).toString('hex')}`;
  const dbPort = await reservePort();
  let appPort = await reservePort();
  while (appPort === dbPort) appPort = await reservePort();
  const origin = `http://127.0.0.1:${appPort}`;
  const environment = isolatedEnvironment();
  let databaseChild = null;
  let appChild = null;
  let stage = 'preflight';
  const check = name => { report.checks.push({ name, passed: true }); onProgress(name); };
  const adminConnection = () => mysql.createConnection({ host: '127.0.0.1', port: dbPort,
    user: 'root', password: rootPassword, connectTimeout: 2000, dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true });
  const dbArgs = [ '--no-defaults', `--basedir=${path.dirname(path.dirname(mysqldPath))}`,
    `--datadir=${dataDir}`, '--bind-address=127.0.0.1', `--port=${dbPort}`,
    '--mysqlx=OFF', '--skip-name-resolve', '--log-error-verbosity=2',
    `--log-error=${path.join(fixtureRoot, 'mysql-private.log')}`,
    `--pid-file=${path.join(fixtureRoot, 'mysql.pid')}`,
    '--innodb-buffer-pool-size=67108864', '--max-connections=20' ];

  async function stopDatabase({ cleanup = false } = {}) {
    if (!isRunning(databaseChild)) return;
    let connection;
    try {
      connection = await adminConnection();
      connection.on('error', () => {});
      await connection.query('SHUTDOWN');
      await waitFor(() => !isRunning(databaseChild), { timeoutMs: 15000 });
      report.cleanup.databaseGracefulShutdown = true;
    } catch (error) {
      if (!cleanup) throw error;
      await stopChild(databaseChild);
      report.cleanup.databaseGracefulShutdown = false;
    } finally { connection?.destroy(); }
  }

  try {
    assert.ok(path.isAbsolute(mysqldPath), 'MYSQLD_PATH_MUST_BE_ABSOLUTE');
    await fs.access(mysqldPath);
    await fs.access(path.join(serviceRoot, 'src', 'test-portal.js'));
    await fs.mkdir(dataDir);
    stage = 'initialize-owned-database';
    const initialize = trackedSpawn(mysqldPath, [ '--no-defaults', '--initialize-insecure',
      `--basedir=${path.dirname(path.dirname(mysqldPath))}`, `--datadir=${dataDir}`, '--mysqlx=OFF',
      `--log-error=${path.join(fixtureRoot, 'mysql-initialize-private.log')}` ], environment);
    await waitForExit(initialize, 60000);
    assert.equal(initialize.exitCode, 0, 'DATABASE_INITIALIZATION_FAILED');
    check('fresh-local-database-initialized');

    stage = 'start-owned-database';
    // Passwords exist only in this temporary bootstrap file, never process args.
    // MySQL processes --init-file before exposing the listener to clients.
    await fs.writeFile(initFile, [
      `ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';`,
      `CREATE USER 'root'@'127.0.0.1' IDENTIFIED BY '${rootPassword}';`,
      "GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;"
    ].join('\n') + '\n', { mode: 0o600 });
    databaseChild = trackedSpawn(mysqldPath, [...dbArgs, `--init-file=${initFile}`], environment);
    await waitFor(async () => {
      if (!isRunning(databaseChild)) throw coded('OWNED_DATABASE_EXITED');
      try { const connection = await adminConnection(); await connection.end(); return true; }
      catch { return false; }
    }, { timeoutMs: 30000 });
    await fs.unlink(initFile);
    check('owned-database-started-on-loopback');

    stage = 'prepare-synthetic-fixture';
    const root = await adminConnection();
    try {
      await root.query(`CREATE DATABASE ${identifier(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      await root.query(`USE ${identifier(dbName)}`);
      for (const operation of [...fixtureSchemaOperations(), ...fixtureSeedOperations(instanceId)]) {
        await root[operation.method](operation.sql, operation.params);
      }
      await root.query(`CREATE USER 'portal_reader'@'127.0.0.1' IDENTIFIED BY '${readPassword}'`);
      for (const table of [...Object.values(BIOMETRIC_TABLES), 'biometric_portal_test_identity']) {
        await root.query(`GRANT SELECT ON ${identifier(dbName)}.${identifier(table)} TO 'portal_reader'@'127.0.0.1'`);
      }
    } finally { await root.end(); }
    check('ten-table-contract-and-test-marker-created');
    check('reader-account-has-table-select-grants-only');

    stage = 'prove-database-write-denial';
    const reader = await mysql.createConnection({ host: '127.0.0.1', port: dbPort,
      database: dbName, user: 'portal_reader', password: readPassword, connectTimeout: 2000 });
    let insertDenied = false;
    try {
      await reader.execute(`INSERT INTO ${identifier(BIOMETRIC_TABLES.people)} (id, person_code, display_name, status) VALUES (?, ?, ?, ?)`,
        ['2', 'TEST-BLOCKED', 'Blocked synthetic write', 'active']);
    } catch (error) { insertDenied = error?.code === 'ER_TABLEACCESS_DENIED_ERROR'; }
    finally { await reader.end(); }
    assert.ok(insertDenied, 'READER_DATABASE_WRITE_WAS_NOT_DENIED');
    check('database-reader-insert-denied');

    const appEnv = { ...environment, NODE_ENV: 'test', PORT: String(appPort),
      BIOMETRIC_TEST_DB_HOST: '127.0.0.1', BIOMETRIC_TEST_DB_PORT: String(dbPort),
      BIOMETRIC_TEST_DB_USER: 'portal_reader', BIOMETRIC_TEST_DB_PASSWORD: readPassword,
      BIOMETRIC_TEST_DB_NAME: dbName, BIOMETRIC_TEST_DB_SSL_MODE: 'disabled',
      BIOMETRIC_TEST_DB_INSTANCE_ID: instanceId, BIOMETRIC_TEST_DB_CONNECT_TIMEOUT_MS: '1500',
      BIOMETRIC_TEST_DB_QUERY_TIMEOUT_MS: '1500', BIOMETRIC_READ_PORTAL_ORIGIN: origin,
      BIOMETRIC_READ_PORTAL_ADMIN_USERNAME: 'test-admin',
      BIOMETRIC_READ_PORTAL_ADMIN_PASSWORD_HASH: await hashPassword(adminPassword) };
    const startApp = async () => {
      appChild = trackedSpawn(process.execPath, ['src/test-portal.js'], appEnv, serviceRoot);
      await waitFor(async () => {
        if (!isRunning(appChild)) throw coded(appFailureCode(appChild));
        return await httpStatus(`${origin}/ready`) === 200;
      }, { timeoutMs: 25000 });
    };
    const login = async () => {
      const response = await fetch(`${origin}/auth/login`, { method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'test-admin', password: adminPassword }),
        signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, 'PORTAL_LOGIN_FAILED');
      const session = await response.json();
      assert.equal(session.mode, 'database-readonly', 'PORTAL_MODE_INVALID');
      assert.equal(session.capabilities.createPerson, false, 'PORTAL_WRITE_CAPABILITY_INVALID');
      return { session, cookie: response.headers.get('set-cookie').split(';')[0] };
    };
    const snapshot = async authentication => {
      const result = {};
      for (const route of ['overview', 'devices', 'people', 'events']) {
        const response = await fetch(`${origin}/api/portal/${route}?limit=10`, {
          headers: { Cookie: authentication.cookie }, signal: AbortSignal.timeout(6000) });
        assert.equal(response.status, 200, 'PORTAL_READ_FAILED');
        result[route] = await response.json();
      }
      assert.deepEqual(result.overview.counts, { devices: 1, people: 1, events: 1 }, 'FIXTURE_COUNTS_CHANGED');
      assert.equal(result.devices.items[0].id, deviceId, 'FIXTURE_DEVICE_ID_CHANGED');
      assert.equal(result.devices.items[0].administrativeStatus, 'active', 'FIXTURE_ADMINISTRATIVE_STATUS_CHANGED');
      assert.equal(result.devices.items[0].status, 'unknown', 'FIXTURE_CONNECTION_STATUS_CHANGED');
      assert.equal(result.people.items[0].id, personId, 'FIXTURE_PERSON_ID_CHANGED');
      assert.equal(result.people.items[0].personCode, 'TEST-100', 'FIXTURE_PERSON_CODE_CHANGED');
      assert.equal(result.events.items[0].id, fixtureUuid, 'FIXTURE_EVENT_UUID_CHANGED');
      assert.equal(result.events.items[0].eventTimeUtc, FIXTURE_EVENT_UTC, 'FIXTURE_EVENT_UTC_CHANGED');
      assert.doesNotMatch(JSON.stringify(result), /FIXTURE-PRIVATE|DEMO-/, 'FIXTURE_PRIVATE_FIELDS_EXPOSED');
      return result;
    };

    stage = 'start-read-only-portal';
    await startApp();
    assert.equal(await httpStatus(`${origin}/health`), 200);
    assert.equal(await httpStatus(`${origin}/api/portal/overview`), 401);
    const authentication = await login();
    const initial = await snapshot(authentication);
    check('real-mysql-records-visible-through-authenticated-portal');
    check('source-ids-and-utc-preserved-without-private-columns');
    stage = 'prove-http-write-denial';
    const write = await fetch(`${origin}/api/portal/people`, { method: 'POST',
      headers: { Cookie: authentication.cookie, Origin: origin, 'Content-Type': 'application/json',
        'X-CSRF-Token': authentication.session.csrfToken },
      body: JSON.stringify({ personCode: 'TEST-BLOCKED', displayName: 'Blocked synthetic write' }),
      signal: AbortSignal.timeout(5000) });
    assert.equal(write.status, 403, 'PORTAL_WRITE_WAS_NOT_DENIED');
    assert.equal((await write.json()).error, 'READ_ONLY');
    check('authenticated-administrator-http-write-denied');

    stage = 'restart-portal';
    await stopChild(appChild);
    await startApp();
    assert.deepEqual(await snapshot(await login()), initial);
    check('data-and-event-identity-survived-portal-restart');

    stage = 'database-outage';
    await stopDatabase();
    await waitFor(async () => await httpStatus(`${origin}/ready`) === 503, { timeoutMs: 15000 });
    assert.equal(await httpStatus(`${origin}/health`), 200);
    check('database-outage-readiness-503-with-liveness-200');

    stage = 'restart-owned-database';
    databaseChild = trackedSpawn(mysqldPath, dbArgs, environment);
    await waitFor(async () => {
      if (!isRunning(databaseChild)) throw coded('OWNED_DATABASE_RESTART_EXITED');
      return await httpStatus(`${origin}/ready`) === 200;
    }, { timeoutMs: 30000 });
    assert.deepEqual(await snapshot(await login()), initial);
    check('data-and-event-identity-survived-database-restart');
    report.passed = true;
  } catch (error) {
    // Never serialize SQL errors/messages, child output, session values or secrets.
    report.failure = { stage, code: safeErrorCode(error) };
    // Only explicitly authored assertion labels may leave the private harness.
    const assertionLabel = /^([A-Z][A-Z0-9_]{1,63})(?:\n|$)/.exec(error?.message ?? '')?.[1];
    if (error?.code === 'ERR_ASSERTION' && assertionLabel) report.failure.check = assertionLabel;
  } finally {
    await stopChild(appChild);
    await stopDatabase({ cleanup: true });
    report.cleanup.portalStopped = !isRunning(appChild);
    report.cleanup.ownedDatabaseStopped = !isRunning(databaseChild);
    try { await fs.unlink(initFile); } catch (error) { if (error.code !== 'ENOENT') report.cleanup.bootstrapRemovalFailed = true; }
    report.cleanup.bootstrapSecretRemoved = !await exists(initFile);
    report.cleanup.fixtureDataRetained = true;
    report.fixtureDirectory = path.relative(serviceRoot, fixtureRoot).replaceAll('\\', '/');
    report.completedAtUtc = new Date().toISOString();
    if (!report.cleanup.portalStopped || !report.cleanup.ownedDatabaseStopped || !report.cleanup.bootstrapSecretRemoved) report.passed = false;
    await fs.writeFile(path.join(verificationDir, 'phase1-step2-mysql-verification.json'), JSON.stringify(report, null, 2));
  }
  return report;
}

function isolatedEnvironment() {
  const allowed = ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'SystemDrive', 'PATHEXT'];
  return Object.fromEntries(allowed.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
}

function trackedSpawn(command, args, env, cwd = serviceRoot) {
  const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.privateOutput = '';
  child.spawnFailure = null;
  const capture = chunk => { child.privateOutput = (child.privateOutput + String(chunk)).slice(-32768); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('error', error => { child.spawnFailure = safeErrorCode(error); });
  return child;
}

function isRunning(child) { return Boolean(child && child.exitCode === null && child.signalCode === null && !child.spawnFailure); }

async function waitForExit(child, timeoutMs) {
  try { await waitFor(() => !isRunning(child), { timeoutMs }); }
  catch (error) { await stopChild(child); throw error; }
}

async function stopChild(child) {
  if (!isRunning(child)) return;
  child.kill();
  await waitFor(() => !isRunning(child), { timeoutMs: 10000 }).catch(() => {});
}

async function waitFor(check, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(150); }
  throw coded('BOUNDED_WAIT_TIMEOUT');
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function httpStatus(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(5000) }); await response.arrayBuffer(); return response.status; }
  catch { return null; }
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function coded(code) { return Object.assign(new Error(code), { code }); }
function safeErrorCode(error) { return /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'VERIFICATION_FAILED'; }
function appFailureCode(child) {
  const match = /read-only test portal failed \(([A-Z][A-Z0-9_]{1,63})\)/.exec(child?.privateOutput ?? '');
  return match?.[1] ?? 'TEST_PORTAL_EXITED';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--mysqld-path')) {
    console.error('[test-portal-verification] INVALID_ARGUMENTS');
    process.exitCode = 1;
  } else {
    try {
      const report = await verifyTestPortalMysql({ ...(args.length ? { mysqldPath: args[1] } : {}) });
      console.log(JSON.stringify({ passed: report.passed, checksPassed: report.checks.length,
        failure: report.failure ?? null, cleanup: report.cleanup }));
      if (!report.passed) process.exitCode = 1;
    } catch (error) {
      console.error(`[test-portal-verification] ${safeErrorCode(error)}`);
      process.exitCode = 1;
    }
  }
}
