import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createLocalIngestMysqlLab, freeLocalPort, until } from './lib/local-mysql-ingest-lab.mjs';
import { ingestSchemaDefinitions, syntheticAttlog } from './test-fixtures/standalone-ingest-fixture.mjs';
import { INGEST_TABLE_PRIVILEGES } from '../src/infrastructure/database/ingest-database.js';
import { loadCloudIngestConfig } from '../src/config/cloud-ingest.js';
import { startCloudIngest } from '../src/infrastructure/ingest/cloud-runtime.js';
import { hashPassword } from '../src/infrastructure/portal/auth.js';
import { BIOMETRIC_TABLES as T } from '../src/infrastructure/storage/biometric-table-names.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function verifyCloudIngestMysql() {
  const report = { startedAtUtc: new Date().toISOString(), passed: false, fixtureOnly: true,
    cloudOrSourceDatabaseConnected: false, actualDeviceConnected: false, checks: [], cleanup: {} };
  let lab;
  let runtime;
  const diagnosticEntries = [];
  const diagnosticLog = { async write(entry) { diagnosticEntries.push(entry); } };
  const check = name => { report.checks.push({ name, passed: true }); console.log(`[cloud-ingest-test] ${name}`); };
  try {
    lab = await createLocalIngestMysqlLab();
    await lab.sql('CREATE DATABASE fingerprint CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', [], null);
    for (const { ddl } of ingestSchemaDefinitions()) await lab.sql(ddl);
    await lab.sql('ALTER TABLE biometric_svc_event_processing ADD COLUMN automatic_finalization_eligible TINYINT UNSIGNED NOT NULL DEFAULT 0');
    const user = `cloud_test_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(32).toString('hex');
    await lab.sql(`CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY '${password}'`, [], null);
    for (const [table, privileges] of Object.entries(INGEST_TABLE_PRIVILEGES)) {
      await lab.sql(`GRANT ${privileges.join(',')} ON fingerprint.\`${table}\` TO '${user}'@'127.0.0.1'`, [], null);
    }
    check('fresh-loopback-mysql-and-exact-ingest-account-prepared');
    const appPort = await freeLocalPort();
    const base = `http://127.0.0.1:${appPort}`;
    const portalPassword = randomBytes(32).toString('base64url');
    const token = randomBytes(48).toString('base64url');
    const basicUsername = `machine_${randomBytes(8).toString('hex')}`;
    const basicPassword = randomBytes(48).toString('base64url');
    const basicAuthorization = `Basic ${Buffer.from(`${basicUsername}:${basicPassword}`).toString('base64')}`;
    const serial = `CLOUD-TEST-${randomBytes(6).toString('hex').toUpperCase()}`;
    const env = { PORT: String(appPort), BIOMETRIC_INGEST_HOST: '127.0.0.1', BIOMETRIC_INGEST_DB_HOST: '127.0.0.1',
      BIOMETRIC_INGEST_DB_PORT: String(lab.port), BIOMETRIC_INGEST_DB_USER: user, BIOMETRIC_INGEST_DB_PASSWORD: password,
      BIOMETRIC_INGEST_DB_NAME: 'fingerprint', BIOMETRIC_INGEST_DB_CONFIRMED_NAME: 'fingerprint', BIOMETRIC_INGEST_DB_SSL_MODE: 'disabled',
      BIOMETRIC_INGEST_TOKEN: token, BIOMETRIC_INGEST_ALLOWED_DEVICES: `zkteco:${serial}`,
      BIOMETRIC_INGEST_USER_PROFILE_PUSH_DEVICES: `zkteco:${serial}`,
      BIOMETRIC_INGEST_BASIC_USERNAME: basicUsername, BIOMETRIC_INGEST_BASIC_PASSWORD: basicPassword,
      BIOMETRIC_PORTAL_ORIGIN: base, BIOMETRIC_PORTAL_ADMIN_USERNAME: 'local-cloud-test', BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH: await hashPassword(portalPassword) };
    const config = loadCloudIngestConfig(env);
    runtime = await startCloudIngest({ config, diagnosticLog });
    const request = async (url, options = {}) => {
      const response = await fetch(base + url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(12000) });
      return response;
    };
    assert.equal((await request('/ready')).status, 200);
    assert.equal((await request('/api/portal/received-punches')).status, 401);
    assert.equal((await request('/api/portal/device-connection-diagnostics')).status, 401);
    const rawCount = async () => { const [[row]] = await lab.sql(`SELECT COUNT(*) AS total FROM \`${T.ingestEvents}\``); return Number(row.total); };
    const tableCounts = async () => Object.fromEntries(await Promise.all(Object.values(T).map(async table => {
      const [[row]] = await lab.sql(`SELECT COUNT(*) AS total FROM \`${table}\``);
      return [table, Number(row.total)];
    })));
    const batch = [syntheticAttlog('2026-11-09 10:15:00', '0'), syntheticAttlog('2026-11-09 18:15:00', '1')].join('\n');
    const postPath = `/iclock/cdata?SN=${serial}&table=ATTLOG`;
    const noAuth = await request(postPath, { method: 'POST', body: batch });
    assert.equal(noAuth.status, 401);
    assert.equal(await rawCount(), 0);
    const [[devicesBefore]] = await lab.sql(`SELECT COUNT(*) AS total FROM \`${T.devices}\``);
    assert.equal(Number(devicesBefore.total), 0);
    check('unauthenticated-device-request-cannot-observe-device-or-persist-data');
    const machineHeaders = { Authorization: `Bearer ${token}` };
    const basicHeaders = { Authorization: basicAuthorization };
    const countsBeforeRejections = await tableCounts();
    const weakBasic = await request(postPath, { method: 'POST', headers: { Authorization: 'Basic cDpw' }, body: batch });
    assert.equal(weakBasic.status, 401);
    await weakBasic.text();
    assert.deepEqual(await tableCounts(), countsBeforeRejections);
    check('unconfigured-short-basic-pair-cannot-write-any-service-table');
    const unknownSerial = `UNKNOWN-TEST-${randomBytes(6).toString('hex').toUpperCase()}`;
    const unknown = await request(`/iclock/cdata?SN=${unknownSerial}&table=ATTLOG`, {
      method: 'POST', headers: basicHeaders, body: batch });
    assert.equal(unknown.status, 403);
    await unknown.text();
    assert.deepEqual(await tableCounts(), countsBeforeRejections);
    check('valid-basic-auth-does-not-bypass-device-allowlist');
    const receipt = await request(postPath, { method: 'POST', headers: basicHeaders, body: batch });
    assert.equal(receipt.status, 200);
    assert.equal(await receipt.text(), 'OK: 2');
    assert.equal(await rawCount(), 2);
    const [[canonical]] = await lab.sql(`SELECT COUNT(*) AS total FROM \`${T.punches}\``);
    assert.equal(Number(canonical.total), 2);
    const [[final]] = await lab.sql(`SELECT COUNT(*) AS total FROM \`${T.finalEvents}\``);
    assert.equal(Number(final.total), 0);
    check('strong-basic-attlog-is-durable-and-canonical-without-finalizing-history');
    assert.equal((await request(postPath, { method: 'POST', headers: machineHeaders, body: batch })).status, 200);
    assert.equal(await rawCount(), 2);
    check('bearer-retry-deduplicates-basic-authenticated-attendance');
    const handshake = await request(`/iclock/cdata?SN=${serial}&options=all&pushver=2.4.1`, { headers: basicHeaders });
    assert.equal(handshake.status, 200);
    assert.ok((await handshake.text()).split('\n').includes('TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser'));
    check('native-basic-handshake-requests-only-attendance-operation-logs-and-user-profiles');
    const operationPath = `/iclock/cdata?SN=${serial}&table=OPERLOG`;
    const templateMarker = `SYNTHETIC-TEMPLATE-${randomBytes(20).toString('hex')}`;
    const operationBody = ['USER PIN=NEW-TEST-2\tName=Synthetic device user\tPri=0\tPasswd=do-not-store\tCard=do-not-store\tGrp=1\tTZ=0000000100000000',
      `FP PIN=NEW-TEST-2\tFID=1\tSize=${templateMarker.length}\tValid=1\tTMP=${templateMarker}`].join('\n');
    const operation = await request(operationPath, { method: 'POST', headers: basicHeaders, body: operationBody });
    assert.equal(operation.status, 200);
    assert.equal(await operation.text(), 'OK');
    assert.equal(await rawCount(), 2);
    check('basic-operlog-accepts-safe-profile-and-discards-template-and-credential-values');
    const updatedName = 'Synthetic renamed device user';
    const updatedOperationBody = operationBody.replace('Synthetic device user', updatedName);
    const updatedOperation = await request(operationPath, { method: 'POST', headers: basicHeaders, body: updatedOperationBody });
    assert.equal(updatedOperation.status, 200);
    assert.equal(await updatedOperation.text(), 'OK');
    const [[updatedUser]] = await lab.sql(`SELECT display_name FROM \`${T.deviceUsers}\` WHERE device_user_id = ?`, ['NEW-TEST-2']);
    assert.equal(updatedUser.display_name, updatedName);
    assert.equal(await rawCount(), 2);
    check('basic-operlog-profile-rename-updates-only-the-device-user-name');
    const login = await request('/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'local-cloud-test', password: portalPassword }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    assert.equal(session.mode, 'database-ingest');
    assert.equal(session.capabilities.receivedRecords, true);
    assert.equal(session.capabilities.createPerson, false);
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    const diagnosticResponse = await request('/api/portal/device-connection-diagnostics', { headers });
    assert.equal(diagnosticResponse.status, 200);
    const diagnostics = await diagnosticResponse.json();
    assert.equal(diagnostics.authenticated, false);
    assert.equal(diagnostics.sampled, true);
    assert.equal(diagnostics.state, 'unauthenticated-attempt-observed');
    assert.equal(diagnostics.recent.length, 2);
    assert.ok(diagnostics.recent.every(item => item.recognizedDevice === true));
    assert.deepEqual(new Set(diagnostics.recent.map(item => item.authorizationKind)), new Set(['none', 'basic']));
    for (const secret of [serial, unknownSerial, token, portalPassword, basicUsername, basicPassword, basicAuthorization,
      templateMarker, 'do-not-store']) {
      assert.equal(JSON.stringify(diagnostics).includes(secret), false);
    }
    assert.equal(await rawCount(), 2);
    check('private-connection-diagnostics-show-rejection-without-secrets-or-extra-attendance-data');
    const overviewResponse = await request('/api/portal/overview', { headers });
    assert.equal(overviewResponse.status, 200);
    const overview = await overviewResponse.json();
    assert.equal(overview.counts.received, 2);
    assert.equal(overview.counts.deviceUsers, 2);
    assert.equal(overview.counts.people, 0);
    assert.equal(overview.counts.events, 0);
    const received = await request('/api/portal/received-punches', { headers });
    assert.equal(received.status, 200);
    const records = await received.json();
    assert.equal(records.page.total, 2);
    assert.equal(records.items[0].hasFinalEvent, false);
    const users = await request('/api/portal/device-users', { headers });
    assert.equal(users.status, 200);
    const userRecords = await users.json();
    assert.equal(userRecords.page.total, 2);
    assert.ok(userRecords.items.every(item => item.mappedPersonCode === null));
    assert.equal(userRecords.items.find(item => item.deviceUserId === 'NEW-TEST-2')?.displayName, updatedName);
    assert.ok(!JSON.stringify(userRecords).includes('do-not-store'));
    const [[storedSecrets]] = await lab.sql(`SELECT COUNT(*) AS total FROM \`${T.deviceUsers}\` WHERE CAST(safe_metadata AS CHAR) LIKE '%do-not-store%'`);
    assert.equal(Number(storedSecrets.total), 0);
    const storedRows = await Promise.all(Object.values(T).map(async table => (await lab.sql(`SELECT * FROM \`${table}\``))[0]));
    const privateStoredText = JSON.stringify(storedRows);
    const safeLogsText = JSON.stringify(diagnosticEntries);
    for (const secret of [password, token, portalPassword, basicUsername, basicPassword, basicAuthorization,
      templateMarker, 'do-not-store']) {
      assert.equal(privateStoredText.includes(secret), false);
      assert.equal(safeLogsText.includes(secret), false);
    }
    assert.equal((await tableCounts())[T.people], 0);
    check('protected-receipt-and-device-user-pages-show-intake-separately-from-final-events-and-people');
    const attempt = await request('/api/portal/people', { method: 'POST', headers: { ...headers, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ personCode: 'DO-NOT-CREATE', displayName: 'test' }) });
    assert.equal(attempt.status, 403);
    for (const route of ['/api/v1/final-events', '/admin/devices']) assert.equal((await request(route, { headers })).status, 404);
    check('portal-write-and-legacy-integration-routes-remain-unavailable');
    await lab.stop();
    assert.equal((await request('/ready')).status, 503);
    assert.equal((await request('/health')).status, 200);
    await lab.start();
    await until(async () => (await request('/ready')).status === 200, 15000);
    assert.equal(await rawCount(), 2);
    check('mysql-outage-is-visible-and-recovers-without-data-loss');
    await runtime.close(); runtime = null;
    runtime = await startCloudIngest({ config, diagnosticLog });
    assert.equal((await request('/ready')).status, 200);
    assert.equal((await request('/auth/session', { headers })).status, 401);
    const restartedLogin = await request('/auth/login', { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'local-cloud-test', password: portalPassword }) });
    assert.equal(restartedLogin.status, 200);
    await restartedLogin.text();
    const freshHeaders = { Cookie: restartedLogin.headers.get('set-cookie').split(';')[0] };
    const restartedDiagnostics = await request('/api/portal/device-connection-diagnostics', { headers: freshHeaders });
    assert.equal(restartedDiagnostics.status, 200);
    const freshSnapshot = await restartedDiagnostics.json();
    assert.equal(freshSnapshot.state, 'no-recent-attempts');
    assert.equal(freshSnapshot.recent.length, 0);
    const countsBeforeResends = await tableCounts();
    for (const authHeaders of [basicHeaders, machineHeaders]) {
      const resend = await request(postPath, { method: 'POST', headers: authHeaders, body: batch });
      assert.equal(resend.status, 200); assert.equal(await resend.text(), 'OK: 2');
      const userResend = await request(operationPath, { method: 'POST', headers: authHeaders, body: updatedOperationBody });
      assert.equal(userResend.status, 200); assert.equal(await userResend.text(), 'OK');
      assert.deepEqual(await tableCounts(), countsBeforeResends);
    }
    assert.equal(await rawCount(), 2);
    check('runtime-restart-revalidates-writer-and-both-auth-methods-deduplicate-attendance-and-users');
    report.passed = true;
  } catch (error) { report.failure = { code: /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'CLOUD_INGEST_VERIFICATION_FAILED', completedChecks: report.checks.length }; }
  finally {
    if (runtime) await runtime.close().catch(() => { report.passed = false; });
    if (lab) { report.cleanup = await lab.close(); report.fixtureDirectory = path.relative(root, lab.directory).replaceAll('\\', '/'); }
    if (lab && (!report.cleanup.mysqlStopped || !report.cleanup.bootstrapRemoved)) report.passed = false;
    report.finishedAtUtc = new Date().toISOString();
    const reportDate = report.startedAtUtc.slice(0, 10);
    await fs.writeFile(path.join(root, `verification/cloud-ingest-native-basic-mysql-verification-${reportDate}.json`), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await verifyCloudIngestMysql();
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
