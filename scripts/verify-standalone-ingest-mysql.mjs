import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { canonicalRowsHash } from './lib/biometric-backup-format.mjs';
import { BIOMETRIC_TABLES } from '../src/infrastructure/storage/biometric-table-names.js';
import { createIngestEvent } from '../src/domain/ingest-event.js';
import { TiDbIngestStore } from '../src/infrastructure/storage/tidb-ingest-store.js';
import { TiDbDeviceStore } from '../src/infrastructure/storage/tidb-device-store.js';
import { parseAttlogBody } from '../src/infrastructure/vendors/zkteco/adms-parser.js';
import { createZktecoAttlogObservations } from '../src/infrastructure/vendors/zkteco/attlog-observation.js';
import { ingestSchemaDefinitions, plannedLocalIngestSchemaAdditions, syntheticAttlog, SYNTHETIC_PIN,
  SYNTHETIC_PERSON_CODE, SIMULATED_PROFILE_SERIAL, INGEST_SCHEMA_VERSION } from './test-fixtures/standalone-ingest-fixture.mjs';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultMysql = 'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqld.exe';
const forbiddenPorts = new Set([9095, 9096, 9097]);
const osKeys = ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'SystemDrive', 'PATHEXT'];
const snapshotColumns = Object.freeze({
  ingest: ['id', 'ingest_key', 'device_id', 'vendor', 'serial_number', 'dedupe_key', 'dedupe_strategy', 'dedupe_version', 'wire_hash', 'safe_payload', 'capture_id', 'capture_index', 'received_at'],
  punches: ['id', 'ingest_event_id', 'event_key', 'device_id', 'device_user_id', 'device_event_time_local', 'device_timezone', 'device_event_time_utc', 'punch_state', 'verification_method', 'wire_hash', 'received_at'],
  final: ['id', 'final_event_uuid', 'person_id', 'person_code', 'source_punch_id', 'device_id', 'event_type', 'event_time_local', 'event_timezone', 'event_time_utc', 'verification_method', 'finalization_version', 'status', 'finalized_at', 'created_at']
});

export function standaloneIngestEnvironment({ appPort, databasePort, databaseName, databaseUser,
  databasePassword, serials, fixtureDirectory }, inherited = process.env) {
  ensure(port(appPort) && port(databasePort) && appPort !== databasePort &&
    !forbiddenPorts.has(appPort) && !forbiddenPorts.has(databasePort), 'INGEST_TEST_PORT_REJECTED');
  ensure(typeof databaseName === 'string' && /^biometric_ingest_test_[a-f0-9]{16}$/.test(databaseName), 'INGEST_TEST_DATABASE_REJECTED');
  ensure(typeof databaseUser === 'string' && /^ingest_app_[a-f0-9]{8}$/.test(databaseUser) &&
    typeof databasePassword === 'string' && databasePassword.length >= 32, 'INGEST_TEST_ACCOUNT_REJECTED');
  ensure(typeof fixtureDirectory === 'string' && path.isAbsolute(fixtureDirectory) && Array.isArray(serials) &&
    serials.length === 2 && new Set(serials).size === 2 && serials.includes(SIMULATED_PROFILE_SERIAL) &&
    serials.some(serial => /^LOCAL-INGEST-[A-F0-9]{16}$/.test(serial)), 'INGEST_TEST_FIXTURE_REJECTED');
  const directory = path.resolve(fixtureDirectory);
  ensure(directory.startsWith(path.join(serviceRoot, 'verification') + path.sep) &&
    path.basename(directory).startsWith('standalone-ingest-mysql-'), 'INGEST_TEST_FIXTURE_PATH_REJECTED');
  return { ...Object.fromEntries(osKeys.filter(key => inherited[key] !== undefined).map(key => [key, inherited[key]])),
    NODE_ENV: 'test', BIOMETRIC_HOST: '127.0.0.1', BIOMETRIC_PORT: String(appPort),
    BIOMETRIC_STORAGE_MODE: 'database', BIOMETRIC_DB_HOST: '127.0.0.1', BIOMETRIC_DB_PORT: String(databasePort),
    BIOMETRIC_DB_USER: databaseUser, BIOMETRIC_DB_PASSWORD: databasePassword, BIOMETRIC_DB_NAME: databaseName,
    BIOMETRIC_DB_SSL_MODE: 'disabled', BIOMETRIC_DB_CONNECTION_LIMIT: '5', BIOMETRIC_DB_REPLAY_LIMIT: '1000',
    BIOMETRIC_DB_RETRY_DELAY_SECONDS: '1', BIOMETRIC_DB_RETRY_SWEEP_SECONDS: '1',
    BIOMETRIC_ALLOWED_DEVICES: serials.map(serial => `zkteco:${serial}`).join(','), BIOMETRIC_ALLOWED_SERIALS: '',
    BIOMETRIC_ATTLOG_ACK_MODE: 'ack', BIOMETRIC_ACK_MODE: 'ack', BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'true',
    BIOMETRIC_ADMIN_ENABLED: 'false', BIOMETRIC_ADMIN_HOST: '127.0.0.1', BIOMETRIC_ADMIN_PORT: String(appPort),
    BIOMETRIC_FINAL_EVENTS_API_ENABLED: 'false', BIOMETRIC_FINAL_EVENTS_API_HOST: '127.0.0.1', BIOMETRIC_FINAL_EVENTS_API_PORT: String(appPort),
    BIOMETRIC_WEB_BRIDGE_ENABLED: 'false', BIOMETRIC_STAGING_PORTAL_ENABLED: 'false',
    BIOMETRIC_CAPTURE_DIR: path.join(directory, 'private-captures'), BIOMETRIC_LOG_DIR: path.join(directory, 'private-service-logs'),
    BIOMETRIC_WEB_BRIDGE_STATE_FILE: path.join(directory, 'private-state', 'cursor.json'),
    BIOMETRIC_LOG_TIMEZONE: 'Asia/Riyadh', BIOMETRIC_LOG_MAX_BYTES: '1048576', BIOMETRIC_LOG_RETAIN_FILES: '2',
    BIOMETRIC_MAX_BODY_BYTES: '524288', BIOMETRIC_ADMS_DELAY_SECONDS: '1', BIOMETRIC_ADMS_ERROR_DELAY_SECONDS: '1',
    BIOMETRIC_ADMS_REALTIME: '1', BIOMETRIC_ADMS_ENCRYPT: '0' };
}

export async function verifyStandaloneIngestMysql({ mysqldPath = process.env.BIOMETRIC_TEST_MYSQLD_PATH || defaultMysql,
  onProgress = value => console.log(`[standalone-ingest-verification] ${value}`), probeHistoricalRetry = true } = {}) {
  const report = { startedAtUtc: new Date().toISOString(), passed: false, mainAcceptancePassed: false,
    fixtureOnly: true, realDeviceContacted: false, cloudOrSourceDatabaseUsed: false, existingServicesChanged: false,
    actualEntryPoint: 'src/index.js', schemaVersion: INGEST_SCHEMA_VERSION,
    localSchemaAddition: 'automatic_finalization_eligible-default-zero', checks: [], cleanup: {} };
  const verificationDir = path.join(serviceRoot, 'verification');
  await fs.mkdir(verificationDir, { recursive: true });
  const fixtureDirectory = await fs.mkdtemp(path.join(verificationDir, 'standalone-ingest-mysql-'));
  const dataDir = path.join(fixtureDirectory, 'data');
  const bootstrap = path.join(fixtureDirectory, 'private-bootstrap.sql');
  const dbName = `biometric_ingest_test_${randomBytes(8).toString('hex')}`;
  const rootPassword = randomBytes(32).toString('hex');
  const appUser = `ingest_app_${randomBytes(4).toString('hex')}`;
  const appPassword = randomBytes(32).toString('hex');
  const fakeSerial = `LOCAL-INGEST-${randomBytes(8).toString('hex').toUpperCase()}`;
  const dbPort = await reservePort();
  let appPort = await reservePort();
  while (appPort === dbPort) appPort = await reservePort();
  const origin = `http://127.0.0.1:${appPort}`;
  const osEnvironment = Object.fromEntries(osKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const appEnvironment = standaloneIngestEnvironment({ appPort, databasePort: dbPort, databaseName: dbName,
    databaseUser: appUser, databasePassword: appPassword, serials: [fakeSerial, SIMULATED_PROFILE_SERIAL], fixtureDirectory }, osEnvironment);
  const dbOptions = { host: '127.0.0.1', port: dbPort, user: 'root', password: rootPassword,
    connectTimeout: 2000, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, multipleStatements: false };
  const admin = withDatabase => mysql.createConnection({ ...dbOptions, ...(withDatabase ? { database: dbName } : {}) });
  const sql = async (statement, params = []) => { const connection = await admin(true); try { return await connection.execute(statement, params); } finally { await connection.end(); } };
  const dbArgs = ['--no-defaults', `--basedir=${path.dirname(path.dirname(mysqldPath))}`, `--datadir=${dataDir}`,
    '--bind-address=127.0.0.1', `--port=${dbPort}`, '--mysqlx=OFF', '--skip-name-resolve', '--max-connections=30',
    '--innodb-buffer-pool-size=67108864', `--log-error=${path.join(fixtureDirectory, 'private-mysql.log')}`,
    `--pid-file=${path.join(fixtureDirectory, 'owned-mysql.pid')}`];
  let dbChild;
  let appChild;
  let stage = 'preflight';
  const check = name => { report.checks.push({ name, passed: true }); onProgress(name); };
  const startDatabase = async initFile => {
    dbChild = child(mysqldPath, [...dbArgs, ...(initFile ? [`--init-file=${initFile}`] : [])], osEnvironment);
    await waitFor(async () => {
      ensure(running(dbChild), 'OWNED_INGEST_DATABASE_EXITED');
      try { const connection = await admin(false); await connection.end(); return true; } catch { return false; }
    }, 30000);
  };
  const stopDatabase = async cleanup => {
    if (!running(dbChild)) return;
    let connection;
    try {
      connection = await admin(false); connection.on('error', () => {}); await connection.query('SHUTDOWN');
      await waitFor(() => !running(dbChild), 15000); report.cleanup.databaseGracefulShutdown = true;
    } catch (error) { if (!cleanup) throw error; await stopChild(dbChild); report.cleanup.databaseGracefulShutdown = false; }
    finally { connection?.destroy(); }
  };
  const startApp = async (autoFinalizeNewCaptures = true) => {
    ensure(typeof autoFinalizeNewCaptures === 'boolean', 'INGEST_TEST_AUTOMATIC_SETTING_INVALID');
    appChild = child(process.execPath, ['src/index.js'], { ...appEnvironment,
      BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: String(autoFinalizeNewCaptures) });
    await waitFor(async () => {
      ensure(running(appChild), 'ACTUAL_INGEST_ENTRY_EXITED');
      return (await request('/health')).status === 200;
    }, 20000);
  };
  const request = async (url, options = {}) => {
    try { const response = await fetch(origin + url, { ...options, signal: AbortSignal.timeout(15000) }); return { status: response.status, text: await response.text() }; }
    catch { return { status: null, text: '' }; }
  };
  const post = (serial, body) => request(`/iclock/cdata?SN=${serial}&table=ATTLOG`, { method: 'POST', body });
  const snapshot = async () => {
    const result = {};
    for (const [label, table] of Object.entries({ ingest: BIOMETRIC_TABLES.ingestEvents, punches: BIOMETRIC_TABLES.punches, final: BIOMETRIC_TABLES.finalEvents })) {
      const columns = snapshotColumns[label];
      const [rows] = await sql(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table)} ORDER BY id`);
      result[label] = { count: rows.length, identityAndContentSha256: canonicalRowsHash(columns, rows) };
    }
    return result;
  };
  const counts = async expected => {
    await waitFor(async () => {
      const result = await snapshot();
      return Object.entries(expected).every(([key, count]) => result[key].count === count);
    }, 10000);
    return snapshot();
  };
  const same = (left, right, code) => ensure(JSON.stringify(left) === JSON.stringify(right), code);

  try {
    ensure(path.isAbsolute(mysqldPath) && typeof probeHistoricalRetry === 'boolean', 'INGEST_TEST_INPUT_REJECTED');
    await fs.access(mysqldPath); await fs.access(path.join(serviceRoot, 'src', 'index.js'));
    await fs.mkdir(dataDir);
    stage = 'initialize-owned-mysql';
    const initialize = child(mysqldPath, ['--no-defaults', '--initialize-insecure',
      `--basedir=${path.dirname(path.dirname(mysqldPath))}`, `--datadir=${dataDir}`, '--mysqlx=OFF',
      `--log-error=${path.join(fixtureDirectory, 'private-initialize.log')}`], osEnvironment);
    try { await waitFor(() => !running(initialize), 60000); }
    catch (error) { await stopChild(initialize); throw error; }
    ensure(initialize.exitCode === 0, 'INGEST_MYSQL_INITIALIZATION_FAILED');
    await fs.writeFile(bootstrap, `ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';\nCREATE USER 'root'@'127.0.0.1' IDENTIFIED BY '${rootPassword}';\nGRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;\n`, { mode: 0o600 });
    await startDatabase(bootstrap); await fs.unlink(bootstrap);
    check('owned-loopback-mysql-initialized-with-fresh-data-directory');

    stage = 'create-full-synthetic-ingest-schema';
    const connection = await admin(false);
    try {
      await connection.query(`CREATE DATABASE ${identifier(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      await connection.query(`USE ${identifier(dbName)}`);
      for (const definition of ingestSchemaDefinitions()) await connection.query(definition.ddl);
      ensure(/^biometric_ingest_test_[a-f0-9]{16}$/.test(dbName), 'INGEST_TEST_LOCAL_ALTER_TARGET_REJECTED');
      for (const addition of plannedLocalIngestSchemaAdditions()) await connection.query(addition.ddl);
      for (const serial of [fakeSerial, SIMULATED_PROFILE_SERIAL]) {
        const [device] = await connection.execute(`INSERT INTO ${identifier(BIOMETRIC_TABLES.devices)} (vendor,serial_number,display_name,mode,status,timezone,accept_events_from) VALUES ('zkteco',?,?,'test','active','Asia/Riyadh',NULL)`, [serial, 'Synthetic local ingest terminal']);
        const [person] = await connection.execute(`INSERT INTO ${identifier(BIOMETRIC_TABLES.people)} (person_code,display_name,status) VALUES (?,?,'active')`, [`${SYNTHETIC_PERSON_CODE}-${serial === fakeSerial ? 'UNKNOWN' : 'PROFILE'}`, 'Synthetic local acceptance person']);
        const [deviceUser] = await connection.execute(`INSERT INTO ${identifier(BIOMETRIC_TABLES.deviceUsers)} (device_id,device_user_id,display_name,status,metadata_schema_version,first_seen_at,last_seen_at) VALUES (?,?,?,'seen',1,CURRENT_TIMESTAMP(6),CURRENT_TIMESTAMP(6))`, [device.insertId, SYNTHETIC_PIN, 'Synthetic local device user']);
        await connection.execute(`INSERT INTO ${identifier(BIOMETRIC_TABLES.personDeviceUsers)} (person_id,device_user_row_id,status) VALUES (?,?,'active')`, [person.insertId, deviceUser.insertId]);
      }
      await connection.query(`CREATE USER '${appUser}'@'127.0.0.1' IDENTIFIED BY '${appPassword}'`);
      for (const table of Object.values(BIOMETRIC_TABLES)) await connection.query(`GRANT SELECT,INSERT,UPDATE ON ${identifier(dbName)}.${identifier(table)} TO '${appUser}'@'127.0.0.1'`);
    } finally { await connection.end(); }
    check('full-runtime-schema-and-two-synthetic-device-person-mappings-created');

    stage = 'start-actual-index-entry';
    await startApp();
    for (const route of ['/api/overview', '/api/v1/final-events', '/login']) ensure((await request(route)).status === 404, 'INGEST_DISABLED_INTERFACE_WAS_EXPOSED');
    ensure((await request('/iclock/cdata?SN=NOT-ALLOWLISTED&options=all')).status === 403, 'INGEST_ALLOWLIST_NOT_ENFORCED');
    const handshake = await request(`/iclock/cdata?SN=${fakeSerial}&options=all`);
    ensure(handshake.status === 200 && handshake.text.includes(`GET OPTION FROM: ${fakeSerial}`), 'INGEST_HANDSHAKE_FAILED');
    const options = await request(`/iclock/cdata?SN=${fakeSerial}&table=OPTIONS`, { method: 'POST', body: `~SerialNumber=${fakeSerial},DeviceName=Synthetic localhost fixture,PushVersion=2.4.1` });
    ensure(options.status === 200 && options.text === 'OK', 'INGEST_OPTIONS_FAILED');
    check('actual-runtime-handshake-options-allowlist-and-disabled-interfaces-verified');

    const firstBatch = [syntheticAttlog('2026-11-09 10:15:00', '0'), syntheticAttlog('2026-11-09 18:15:00', '1')].join('\n');
    stage = 'capture-unprofiled-synthetic-attlog';
    let response = await post(fakeSerial, firstBatch);
    ensure(response.status === 200 && response.text === 'OK: 2', 'INGEST_FAKE_ATTLOG_NOT_ACKNOWLEDGED');
    await counts({ ingest: 2, punches: 2, final: 0 });
    const [unknown] = await sql(`SELECT COUNT(*) AS total FROM ${identifier(BIOMETRIC_TABLES.finalizationIssues)} WHERE issue_type='unknown_event_type' AND status='open'`);
    ensure(Number(unknown[0]?.total) === 2, 'INGEST_UNKNOWN_PROFILE_NOT_RETAINED_FOR_REVIEW');
    report.unprofiledSemantics = { recordsDurablyCaptured: 2, guessedFinalEvents: 0, reviewIssues: 2 };
    check('fake-serial-attlog-durably-captured-without-inventing-event-semantics');

    stage = 'finalize-known-profile-simulation';
    response = await post(SIMULATED_PROFILE_SERIAL, firstBatch);
    ensure(response.status === 200 && response.text === 'OK: 2', 'INGEST_PROFILE_ATTLOG_NOT_ACKNOWLEDGED');
    const accepted = await counts({ ingest: 4, punches: 4, final: 2 });
    const [finalRows] = await sql(`SELECT event_type,event_time_utc,verification_method FROM ${identifier(BIOMETRIC_TABLES.finalEvents)} ORDER BY event_time_utc`);
    ensure(finalRows[0]?.event_type === 'check_in' && finalRows[1]?.event_type === 'check_out' &&
      String(finalRows[0]?.event_time_utc).startsWith('2026-11-09 07:15:00') &&
      finalRows.every(row => row.verification_method === 'fingerprint'), 'INGEST_PROFILE_FINALIZATION_INVALID');
    report.profileSimulation = { simulatedIdentityOnly: true, physicalDeviceContacted: false,
      finalEvents: 2, expectedTypesAndRiyadhToUtcVerified: true };
    check('existing-normalization-profile-simulated-through-real-http-and-automatic-finalization');

    stage = 'retry-identical-http-batches';
    for (const serial of [fakeSerial, SIMULATED_PROFILE_SERIAL]) {
      response = await post(serial, firstBatch);
      ensure(response.status === 200 && response.text === 'OK: 2', 'INGEST_DUPLICATE_BATCH_ACK_INVALID');
    }
    same(await snapshot(), accepted, 'INGEST_DUPLICATE_CHANGED_EVENT_IDENTITY_OR_CONTENT');
    check('duplicate-http-batches-preserve-ingest-punch-and-final-event-identities');

    stage = 'prove-no-ack-without-durable-ingest';
    const failedPacket = syntheticAttlog('2026-11-09 12:00:00', '0');
    let rootConnection = await admin(false);
    try { await rootConnection.query(`REVOKE INSERT ON ${identifier(dbName)}.${identifier(BIOMETRIC_TABLES.ingestEvents)} FROM '${appUser}'@'127.0.0.1'`); }
    finally { await rootConnection.end(); }
    response = await post(SIMULATED_PROFILE_SERIAL, failedPacket);
    ensure([500, 503].includes(response.status) && !/^OK(?:\b|:)/.test(response.text), 'INGEST_UNDURABLE_EVENT_WAS_ACKNOWLEDGED');
    same(await snapshot(), accepted, 'INGEST_FAILED_DURABILITY_CHANGED_RECORDS');
    rootConnection = await admin(false);
    try { await rootConnection.query(`GRANT INSERT ON ${identifier(dbName)}.${identifier(BIOMETRIC_TABLES.ingestEvents)} TO '${appUser}'@'127.0.0.1'`); }
    finally { await rootConnection.end(); }
    response = await post(SIMULATED_PROFILE_SERIAL, failedPacket);
    ensure(response.status === 200 && response.text === 'OK: 1', 'INGEST_RECOVERY_PACKET_NOT_ACKNOWLEDGED');
    const recovered = await counts({ ingest: 5, punches: 5, final: 3 });
    const [[eligibility]] = await sql(`SELECT COUNT(*) AS total, SUM(automatic_finalization_eligible=1) AS eligible FROM ${identifier(BIOMETRIC_TABLES.eventProcessing)}`);
    ensure(Number(eligibility.total) === 5 && Number(eligibility.eligible) === 5, 'INGEST_NEW_HTTP_CAPTURE_ELIGIBILITY_NOT_DURABLE');
    report.newHttpCaptureEligibility = { captures: 5, durablyEligible: 5 };
    check('durable-write-failure-withholds-ack-and-same-packet-recovers-after-storage-access-restored');

    stage = 'restart-actual-entry';
    await stopChild(appChild); await startApp();
    same(await snapshot(), recovered, 'INGEST_APP_RESTART_CHANGED_EVENT_IDENTITY_OR_CONTENT');
    check('actual-entry-restart-preserves-durable-event-identities-and-content-hashes');

    stage = 'restart-owned-mysql';
    await stopDatabase(false);
    ensure((await request('/health')).status === 200, 'INGEST_DATABASE_OUTAGE_STOPPED_LISTENER');
    await startDatabase();
    await waitFor(async () => { try { return JSON.stringify(await snapshot()) === JSON.stringify(recovered); } catch { return false; } }, 15000);
    same(await snapshot(), recovered, 'INGEST_MYSQL_RESTART_CHANGED_EVENT_IDENTITY_OR_CONTENT');
    await waitFor(async () => {
      response = await post(SIMULATED_PROFILE_SERIAL, failedPacket);
      return response.status === 200 && response.text === 'OK: 1';
    }, 10000);
    same(await snapshot(), recovered, 'INGEST_DATABASE_RESTART_DUPLICATED_EVENT');
    report.mainAcceptancePassed = true;
    report.acceptedSnapshot = recovered;
    check('owned-mysql-restart-and-device-retry-preserve-durable-event-identities');

    if (probeHistoricalRetry) {
      stage = 'probe-existing-historical-retry-boundary';
      const rawFixture = async (timestamp, future, autoFinalizeNewCaptures = false) => {
        const pool = mysql.createPool({ ...dbOptions, database: dbName, user: appUser, password: appPassword, connectionLimit: 2 });
        try {
          const device = { vendor: 'zkteco', serialNumber: SIMULATED_PROFILE_SERIAL };
          const observation = createZktecoAttlogObservations({ device, parsedLines: parseAttlogBody(syntheticAttlog(timestamp, '0')),
            parserVersion: 'synthetic-local-restart-probe-v1' })[0];
          const receivedAt = autoFinalizeNewCaptures ? new Date().toISOString() : `${timestamp.replace(' ', 'T')}Z`;
          const event = createIngestEvent({ device, observation, receivedAt, remoteAddress: '127.0.0.1', captureId: randomUUID(), captureIndex: 0 });
          const store = new TiDbIngestStore({ pool, deviceStore: new TiDbDeviceStore(pool), autoFinalizeNewCaptures });
          await store.init();
          const result = await store.putIfAbsent(event);
          ensure(result.record.automaticFinalizationEligible === autoFinalizeNewCaptures, 'INGEST_RAW_FIXTURE_DURABLE_ELIGIBILITY_INVALID');
          const id = result.record.ingestEventId;
          await sql(`UPDATE ${identifier(BIOMETRIC_TABLES.eventProcessing)} SET status=?, next_attempt_at=${future ? 'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 10 SECOND)' : 'NULL'} WHERE ingest_event_id=?`, [future ? 'retry' : 'pending', id]);
          return id;
        } finally { await pool.end(); }
      };
      const historicalState = async ingestId => {
        const [[row]] = await sql(`SELECT
          (SELECT COUNT(*) FROM ${identifier(BIOMETRIC_TABLES.punches)} WHERE ingest_event_id=?) AS punches,
          (SELECT COUNT(*) FROM ${identifier(BIOMETRIC_TABLES.finalEvents)} f JOIN ${identifier(BIOMETRIC_TABLES.punches)} p ON p.id=f.source_punch_id WHERE p.ingest_event_id=?) AS final_events,
          (SELECT COUNT(*) FROM ${identifier(BIOMETRIC_TABLES.finalizationIssues)} i JOIN ${identifier(BIOMETRIC_TABLES.punches)} p ON p.id=i.source_punch_id WHERE p.ingest_event_id=? AND i.issue_type='automatic_finalization_pending') AS automatic_intents`, [ingestId, ingestId, ingestId]);
        return { punches: Number(row.punches), finalEvents: Number(row.final_events), automaticIntents: Number(row.automatic_intents) };
      };
      await stopChild(appChild);
      const dueId = await rawFixture('2026-01-01 10:00:00', false);
      await startApp();
      const due = await historicalState(dueId);
      ensure(due.punches === 1 && due.finalEvents === 0 && due.automaticIntents === 0, 'INGEST_STARTUP_HISTORICAL_BOUNDARY_FAILED');
      response = await post(SIMULATED_PROFILE_SERIAL, syntheticAttlog('2026-01-01 10:00:00', '0'));
      ensure(response.status === 200 && response.text === 'OK: 1', 'INGEST_HISTORICAL_DUPLICATE_ACK_FAILED');
      const duplicate = await historicalState(dueId);
      ensure(duplicate.finalEvents === 0 && duplicate.automaticIntents === 0, 'INGEST_HISTORICAL_DUPLICATE_CREATED_INTENT');

      await stopChild(appChild);
      const futureId = await rawFixture('2026-01-02 10:00:00', true);
      await startApp();
      const atStartup = await historicalState(futureId);
      ensure(atStartup.punches === 0 && atStartup.finalEvents === 0, 'INGEST_HISTORICAL_PROBE_STARTUP_WINDOW_INVALID');
      await waitFor(async () => (await historicalState(futureId)).punches === 1, 20000);
      let afterRetry = await historicalState(futureId);
      if (afterRetry.automaticIntents > 0) {
        await waitFor(async () => (await historicalState(futureId)).finalEvents > 0, 5000).catch(() => {});
        afterRetry = await historicalState(futureId);
      }
      const passed = afterRetry.finalEvents === 0 && afterRetry.automaticIntents === 0;
      report.historicalRetryBoundary = { performed: true, fixtureExistedBeforeEntryStart: true,
        noFreshHttpOrAdminFinalizationForFutureFixture: true, startupDueControl: due,
        duplicateControl: duplicate, futureAtStartup: atStartup, futureAfterRetry: afterRetry, passed };
      if (!passed) throw fail('INGEST_HISTORICAL_RETRY_AUTOMATIC_FINALIZATION_OBSERVED');
      check('preexisting-delayed-historical-ingest-does-not-create-automatic-finalization-intent');

      stage = 'recover-durably-eligible-new-capture';
      const finalIdentity = async ingestId => {
        const columns = ['ingest_id', 'punch_id', 'final_event_id', 'final_event_uuid'];
        const [rows] = await sql(`SELECT p.ingest_event_id AS ingest_id, p.id AS punch_id, f.id AS final_event_id, f.final_event_uuid
          FROM ${identifier(BIOMETRIC_TABLES.punches)} p JOIN ${identifier(BIOMETRIC_TABLES.finalEvents)} f ON f.source_punch_id=p.id
          WHERE p.ingest_event_id=? ORDER BY f.id`, [ingestId]);
        ensure(rows.length === 1, 'INGEST_ELIGIBLE_CAPTURE_FINAL_EVENT_NOT_EXACTLY_ONCE');
        return { finalEvents: rows.length, identitySha256: canonicalRowsHash(columns, rows) };
      };
      await stopChild(appChild);
      const eligibleDueId = await rawFixture('2026-11-09 13:00:00', false, true);
      await startApp();
      await waitFor(async () => (await historicalState(eligibleDueId)).finalEvents === 1, 10000);
      const dueNew = await historicalState(eligibleDueId);
      ensure(dueNew.punches === 1 && dueNew.automaticIntents === 1, 'INGEST_ELIGIBLE_STARTUP_INTENT_MISSING');
      const dueNewIdentity = await finalIdentity(eligibleDueId);
      response = await post(SIMULATED_PROFILE_SERIAL, syntheticAttlog('2026-11-09 13:00:00', '0'));
      ensure(response.status === 200 && response.text === 'OK: 1', 'INGEST_ELIGIBLE_DUE_DUPLICATE_ACK_FAILED');
      same(await finalIdentity(eligibleDueId), dueNewIdentity, 'INGEST_ELIGIBLE_DUE_DUPLICATE_REISSUED_FINAL_EVENT');
      check('durably-eligible-new-capture-survives-entry-restart-with-one-final-event');

      stage = 'recover-durably-eligible-delayed-new-capture';
      await stopChild(appChild);
      const eligibleFutureId = await rawFixture('2026-11-09 14:00:00', true, true);
      await startApp();
      same(await finalIdentity(eligibleDueId), dueNewIdentity, 'INGEST_ELIGIBLE_PRIOR_FINAL_CHANGED_ON_RESTART');
      const eligibleAtStartup = await historicalState(eligibleFutureId);
      ensure(eligibleAtStartup.punches === 0 && eligibleAtStartup.finalEvents === 0, 'INGEST_ELIGIBLE_DELAYED_PROBE_WINDOW_INVALID');
      await waitFor(async () => (await historicalState(eligibleFutureId)).finalEvents === 1, 20000);
      const delayedNew = await historicalState(eligibleFutureId);
      ensure(delayedNew.punches === 1 && delayedNew.automaticIntents === 1, 'INGEST_ELIGIBLE_DELAYED_INTENT_MISSING');
      const delayedIdentity = await finalIdentity(eligibleFutureId);
      response = await post(SIMULATED_PROFILE_SERIAL, syntheticAttlog('2026-11-09 14:00:00', '0'));
      ensure(response.status === 200 && response.text === 'OK: 1', 'INGEST_ELIGIBLE_DELAYED_DUPLICATE_ACK_FAILED');
      same(await finalIdentity(eligibleFutureId), delayedIdentity, 'INGEST_ELIGIBLE_DELAYED_DUPLICATE_REISSUED_FINAL_EVENT');
      check('durably-eligible-delayed-first-canonical-processing-resumes-once-after-restart');

      stage = 'resume-eligible-intent-after-automatic-feature-off-on';
      await stopChild(appChild);
      const switchedId = await rawFixture('2026-11-09 15:00:00', false, true);
      await startApp(false);
      const whileOff = await historicalState(switchedId);
      ensure(whileOff.punches === 1 && whileOff.finalEvents === 0 && whileOff.automaticIntents === 1,
        'INGEST_ELIGIBLE_INTENT_NOT_PRESERVED_WHILE_FEATURE_OFF');
      await stopChild(appChild);
      await startApp(true);
      await waitFor(async () => (await historicalState(switchedId)).finalEvents === 1, 10000);
      const afterOn = await historicalState(switchedId);
      ensure(afterOn.punches === 1 && afterOn.automaticIntents === 1, 'INGEST_ELIGIBLE_FEATURE_RESUME_DUPLICATED_INTENT');
      const switchedIdentity = await finalIdentity(switchedId);
      response = await post(SIMULATED_PROFILE_SERIAL, syntheticAttlog('2026-11-09 15:00:00', '0'));
      ensure(response.status === 200 && response.text === 'OK: 1', 'INGEST_ELIGIBLE_RESUMED_DUPLICATE_ACK_FAILED');
      same(await finalIdentity(switchedId), switchedIdentity, 'INGEST_ELIGIBLE_RESUMED_EVENT_REISSUED');
      report.eligibleCaptureRecovery = { startupDue: { ...dueNew, ...dueNewIdentity },
        delayedAtStartup: eligibleAtStartup, delayedAfterRetry: { ...delayedNew, ...delayedIdentity },
        featureOff: whileOff, featureBackOn: { ...afterOn, ...switchedIdentity }, passed: true };
      check('captured-on-canonicalized-off-durable-intent-resumes-on-without-duplicate-final-event');
    } else report.historicalRetryBoundary = { performed: false, passed: null };
    report.passed = true;
  } catch (error) {
    report.failure = { stage, code: safeCode(error) };
  } finally {
    await stopChild(appChild); await stopDatabase(true);
    try { await fs.unlink(bootstrap); } catch (error) { if (error.code !== 'ENOENT') report.cleanup.bootstrapRemovalFailed = true; }
    report.cleanup.actualEntryStopped = !running(appChild); report.cleanup.ownedMysqlStopped = !running(dbChild);
    report.cleanup.bootstrapSecretRemoved = !await exists(bootstrap); report.cleanup.fixtureDataRetained = true;
    report.fixtureDirectory = path.relative(serviceRoot, fixtureDirectory).replaceAll('\\', '/');
    report.completedAtUtc = new Date().toISOString();
    if (!report.cleanup.actualEntryStopped || !report.cleanup.ownedMysqlStopped || !report.cleanup.bootstrapSecretRemoved) report.passed = false;
    await fs.writeFile(path.join(verificationDir, 'standalone-ingest-mysql-eligibility-verification.json'), JSON.stringify(report, null, 2));
  }
  return report;
}

function port(value) { return Number.isSafeInteger(value) && value >= 1024 && value <= 65535; }
function identifier(value) { ensure(typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value), 'INGEST_TEST_IDENTIFIER_REJECTED'); return `\`${value}\``; }
function fail(code) { return Object.assign(new Error('The isolated standalone ingest verification could not be completed'), { code }); }
function ensure(condition, code) { if (!condition) throw fail(code); }
function safeCode(error) { return /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'INGEST_VERIFICATION_FAILED'; }
function child(command, args, env) {
  const process = spawn(command, args, { cwd: serviceRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  process.privateOutput = ''; process.spawnFailure = null;
  const capture = bytes => { process.privateOutput = (process.privateOutput + String(bytes)).slice(-32768); };
  process.stdout.on('data', capture); process.stderr.on('data', capture); process.on('error', error => { process.spawnFailure = safeCode(error); });
  return process;
}
function running(process) { return Boolean(process && process.exitCode === null && process.signalCode === null && !process.spawnFailure); }
async function stopChild(process) { if (!running(process)) return; process.kill(); await waitFor(() => !running(process), 10000).catch(() => {}); }
async function waitFor(check, milliseconds) { const until = Date.now() + milliseconds; while (Date.now() < until) { if (await check()) return; await delay(150); } throw fail('INGEST_BOUNDED_WAIT_TIMEOUT'); }
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (forbiddenPorts.has(value)) return reservePort();
  return value;
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--mysqld-path')) { console.error('INGEST_VERIFICATION_ARGUMENTS_INVALID'); process.exitCode = 1; }
  else {
    try {
      const report = await verifyStandaloneIngestMysql({ ...(args.length ? { mysqldPath: args[1] } : {}) });
      console.log(JSON.stringify({ passed: report.passed, mainAcceptancePassed: report.mainAcceptancePassed,
        checksPassed: report.checks.length, historicalRetryBoundary: report.historicalRetryBoundary ?? null,
        failure: report.failure ?? null, cleanup: report.cleanup }));
      if (!report.passed) process.exitCode = 1;
    } catch (error) { console.error(safeCode(error)); process.exitCode = 1; }
  }
}
