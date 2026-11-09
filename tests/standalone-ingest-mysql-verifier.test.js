import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { standaloneIngestEnvironment } from '../scripts/verify-standalone-ingest-mysql.mjs';
import { ingestSchemaDefinitions, plannedLocalIngestSchemaAdditions, syntheticAttlog, SIMULATED_PROFILE_SERIAL, SYNTHETIC_PIN } from '../scripts/test-fixtures/standalone-ingest-fixture.mjs';
import { REQUIRED_BIOMETRIC_COLUMNS, REQUIRED_BIOMETRIC_UNIQUE_INDEXES } from '../src/infrastructure/storage/biometric-table-names.js';
import { parseAttlogBody } from '../src/infrastructure/vendors/zkteco/adms-parser.js';
import { createZktecoAttlogObservations } from '../src/infrastructure/vendors/zkteco/attlog-observation.js';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = path.join(serviceRoot, 'verification', 'standalone-ingest-mysql-unit-fixture');
const config = { appPort: 49101, databasePort: 49102, databaseName: 'biometric_ingest_test_0123456789abcdef',
  databaseUser: 'ingest_app_01234567', databasePassword: 'Synthetic-local-password-not-a-real-secret-2026',
  serials: ['LOCAL-INGEST-0123456789ABCDEF', SIMULATED_PROFILE_SERIAL], fixtureDirectory };

test('ingest child environment discards inherited production settings and forces owned loopback runtime paths', () => {
  const env = standaloneIngestEnvironment(config, { SystemRoot: 'C:/Windows', PATH: 'synthetic-path',
    NODE_OPTIONS: '--require=do-not-load', TIDB_SOURCE_PASSWORD: 'not-inherited',
    BIOMETRIC_DB_HOST: 'production.invalid', BIOMETRIC_DB_NAME: 'test', BIOMETRIC_DB_PASSWORD: 'not-inherited',
    BIOMETRIC_HOST: '0.0.0.0', BIOMETRIC_PORT: '9095', BIOMETRIC_WEB_BRIDGE_ENABLED: 'true',
    BIOMETRIC_WEB_BRIDGE_TARGET_URL: 'https://do-not-contact.invalid', BIOMETRIC_FINAL_EVENTS_API_TOKEN: 'not-inherited',
    BIOMETRIC_ADMIN_ENABLED: 'true', BIOMETRIC_CAPTURE_DIR: 'C:/Tolan/captures' });
  assert.equal(env.SystemRoot, 'C:/Windows');
  assert.equal(env.PATH, 'synthetic-path');
  assert.equal(env.BIOMETRIC_HOST, '127.0.0.1');
  assert.equal(env.BIOMETRIC_DB_HOST, '127.0.0.1');
  assert.equal(env.BIOMETRIC_DB_NAME, config.databaseName);
  assert.equal(env.BIOMETRIC_DB_PASSWORD, config.databasePassword);
  assert.equal(env.BIOMETRIC_DB_SSL_MODE, 'disabled');
  assert.equal(env.BIOMETRIC_PORT, '49101');
  assert.equal(env.BIOMETRIC_DB_PORT, '49102');
  for (const key of ['BIOMETRIC_ADMIN_ENABLED', 'BIOMETRIC_FINAL_EVENTS_API_ENABLED', 'BIOMETRIC_WEB_BRIDGE_ENABLED', 'BIOMETRIC_STAGING_PORTAL_ENABLED']) assert.equal(env[key], 'false');
  assert.equal(env.BIOMETRIC_ATTLOG_ACK_MODE, 'ack');
  assert.equal(env.BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES, 'true');
  assert.equal(env.BIOMETRIC_STORAGE_MODE, 'database');
  assert.equal(Object.keys(env).some(key => key.startsWith('TIDB_') || key === 'NODE_OPTIONS' || key.endsWith('_TOKEN') || key.endsWith('_TARGET_URL')), false);
  for (const key of ['BIOMETRIC_CAPTURE_DIR', 'BIOMETRIC_LOG_DIR', 'BIOMETRIC_WEB_BRIDGE_STATE_FILE']) assert.ok(env[key].startsWith(fixtureDirectory + path.sep));
});

test('ingest child cannot target legacy ports, source schemas, arbitrary credentials, serials or runtime directories', () => {
  for (const change of [
    { appPort: 9095 }, { appPort: 9096 }, { appPort: 9097 }, { databasePort: 9095 },
    { appPort: config.databasePort }, { databaseName: 'test' }, { databaseName: 'fingerprint' },
    { databaseUser: 'root' }, { databasePassword: '' }, { serials: [SIMULATED_PROFILE_SERIAL] },
    { serials: ['OTHER-REAL-DEVICE', SIMULATED_PROFILE_SERIAL] },
    { fixtureDirectory: path.resolve(serviceRoot, '..', 'finger', 'biometric-service', 'var') },
    { fixtureDirectory: 'relative/path' }
  ]) assert.throws(() => standaloneIngestEnvironment({ ...config, ...change }, {}));
});

test('acceptance fixture carries complete runtime types, defaults and unique indexes for exactly ten tables', () => {
  const definitions = ingestSchemaDefinitions();
  assert.equal(definitions.length, 10);
  assert.deepEqual(definitions.map(item => item.table).sort(), Object.keys(REQUIRED_BIOMETRIC_COLUMNS).sort());
  for (const { table, ddl } of definitions) {
    for (const column of REQUIRED_BIOMETRIC_COLUMNS[table]) {
      if (table === 'biometric_svc_event_processing' && column === 'automatic_finalization_eligible') continue;
      assert.ok(ddl.includes('`' + column + '`'), 'required column absent');
    }
    for (const index of Object.keys(REQUIRED_BIOMETRIC_UNIQUE_INDEXES[table] ?? {})) {
      assert.ok(index === 'PRIMARY' ? ddl.includes('PRIMARY KEY') : ddl.includes('`' + index + '`'), 'required unique index absent');
    }
    assert.doesNotMatch(ddl, /CREATE TABLE\s+`?(?:test|fingerprint)`?\./i);
    assert.match(ddl, /utf8mb4_bin/i);
  }
  const ingest = definitions.find(item => item.table === 'biometric_svc_ingest_events').ddl;
  const processing = definitions.find(item => item.table === 'biometric_svc_event_processing').ddl;
  assert.match(ingest, /`id`\s+bigint[^,]*AUTO_INCREMENT/i);
  assert.match(ingest, /`safe_payload`\s+json/i);
  assert.match(ingest, /`created_at`\s+datetime\(6\)[^,]*CURRENT_TIMESTAMP/i);
  assert.match(processing, /`attempt_count`\s+int[^,]*DEFAULT '0'/i);
  assert.match(processing, /`next_attempt_at`\s+datetime\(6\)/i);
});

test('durable eligibility addition is a separate explicit local ALTER with a non-upgrading default', () => {
  const additions = plannedLocalIngestSchemaAdditions();
  assert.equal(additions.length, 1);
  assert.equal(additions[0].table, 'biometric_svc_event_processing');
  assert.match(additions[0].ddl, /^ALTER TABLE `biometric_svc_event_processing` ADD COLUMN `automatic_finalization_eligible` TINYINT UNSIGNED NOT NULL DEFAULT 0$/);
  assert.doesNotMatch(additions[0].ddl, /fingerprint|`test`|DROP|UPDATE|INSERT|DEFAULT 1/);
  const original = ingestSchemaDefinitions().find(item => item.table === additions[0].table).ddl;
  assert.equal(original.includes('automatic_finalization_eligible'), false);
});

test('synthetic ATTLOG has a safe shape while only the explicitly simulated known profile receives event semantics', () => {
  const body = syntheticAttlog('2026-11-09 10:15:00', '0');
  const parsedLines = parseAttlogBody(body);
  assert.equal(parsedLines.length, 1);
  assert.equal(parsedLines[0].deviceUserId, SYNTHETIC_PIN);
  const fake = createZktecoAttlogObservations({ device: { vendor: 'zkteco', serialNumber: config.serials[0] }, parsedLines, parserVersion: 'synthetic-unit' })[0];
  const known = createZktecoAttlogObservations({ device: { vendor: 'zkteco', serialNumber: SIMULATED_PROFILE_SERIAL }, parsedLines, parserVersion: 'synthetic-unit' })[0];
  assert.equal(fake.safeToAcknowledge, true);
  assert.equal(fake.canonicalPayload.punchState, null);
  assert.equal(known.safeToAcknowledge, true);
  assert.equal(known.canonicalPayload.punchState, 'check_in');
  assert.equal(known.canonicalPayload.verificationMethod, 'fingerprint');
  assert.throws(() => syntheticAttlog('invalid date'));
  assert.throws(() => syntheticAttlog('2026-11-09 10:15:00', 'DROP'));
});
