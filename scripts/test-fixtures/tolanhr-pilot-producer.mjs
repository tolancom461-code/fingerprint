import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadCloudIngestConfig } from '../../src/config/cloud-ingest.js';
import { INGEST_TABLE_PRIVILEGES } from '../../src/infrastructure/database/ingest-database.js';
import { startCloudIngest } from '../../src/infrastructure/ingest/cloud-runtime.js';
import { hashPassword } from '../../src/infrastructure/portal/auth.js';
import { BIOMETRIC_TABLES as T } from '../../src/infrastructure/storage/biometric-table-names.js';
import { createLocalIngestMysqlLab, freeLocalPort } from '../lib/local-mysql-ingest-lab.mjs';
import {
  ingestSchemaDefinitions, plannedLocalIngestSchemaAdditions, SIMULATED_PROFILE_SERIAL,
  SYNTHETIC_PERSON_CODE, syntheticAttlog
} from './standalone-ingest-fixture.mjs';

const personCodes = [SYNTHETIC_PERSON_CODE, 'TEST-INGEST-NO-WORKER'];

export async function startSyntheticFingerprintPilot() {
  const lab = await createLocalIngestMysqlLab();
  let runtime;
  let closing;
  function close() {
    closing ??= (async () => {
      try {
        await runtime?.close();
      } finally {
        const cleanup = await lab.close();
        assert.ok(cleanup.mysqlStopped && cleanup.initializerStopped && cleanup.bootstrapRemoved);
      }
    })();
    return closing;
  }
  try {
    await lab.sql('CREATE DATABASE fingerprint CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', [], null);
    for (const { ddl } of [...ingestSchemaDefinitions(), ...plannedLocalIngestSchemaAdditions()]) {
      await lab.sql(ddl);
    }
    const [device] = await lab.sql(`INSERT INTO \`${T.devices}\` (vendor, serial_number, timezone)
      VALUES ('zkteco', ?, 'Asia/Riyadh')`, [SIMULATED_PROFILE_SERIAL]);
    for (const personCode of personCodes) {
      const [person] = await lab.sql(`INSERT INTO \`${T.people}\` (person_code, display_name) VALUES (?, ?)`,
        [personCode, personCode]);
      const [user] = await lab.sql(`INSERT INTO \`${T.deviceUsers}\` (device_id, device_user_id) VALUES (?, ?)`,
        [device.insertId, personCode]);
      await lab.sql(`INSERT INTO \`${T.personDeviceUsers}\` (person_id, device_user_row_id, active_from)
        VALUES (?, ?, '2026-01-01 00:00:00')`, [person.insertId, user.insertId]);
    }

    const dbUser = 'local_pilot_ingest';
    const dbPassword = randomBytes(32).toString('hex');
    await lab.sql(`CREATE USER '${dbUser}'@'127.0.0.1' IDENTIFIED BY '${dbPassword}'`, [], null);
    for (const [table, privileges] of Object.entries(INGEST_TABLE_PRIVILEGES)) {
      await lab.sql(`GRANT ${privileges.join(',')} ON fingerprint.\`${table}\` TO '${dbUser}'@'127.0.0.1'`, [], null);
    }
    const port = await freeLocalPort();
    const apiBase = `http://127.0.0.1:${port}`;
    const token = randomBytes(48).toString('base64url');
    const ingestToken = randomBytes(48).toString('base64url');
    const config = loadCloudIngestConfig({
      PORT: String(port),
      BIOMETRIC_INGEST_HOST: '127.0.0.1',
      BIOMETRIC_INGEST_DB_HOST: '127.0.0.1',
      BIOMETRIC_INGEST_DB_PORT: String(lab.port),
      BIOMETRIC_INGEST_DB_USER: dbUser,
      BIOMETRIC_INGEST_DB_PASSWORD: dbPassword,
      BIOMETRIC_INGEST_DB_NAME: 'fingerprint',
      BIOMETRIC_INGEST_DB_CONFIRMED_NAME: 'fingerprint',
      BIOMETRIC_INGEST_DB_SSL_MODE: 'disabled',
      BIOMETRIC_INGEST_TOKEN: ingestToken,
      BIOMETRIC_INGEST_ALLOWED_DEVICES: `zkteco:${SIMULATED_PROFILE_SERIAL}`,
      BIOMETRIC_INGEST_CONSUMER_API_ENABLED: 'true',
      BIOMETRIC_INGEST_CONSUMER_API_TOKEN: token,
      BIOMETRIC_PORTAL_ORIGIN: apiBase,
      BIOMETRIC_PORTAL_ADMIN_USERNAME: 'local-pilot',
      BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH: await hashPassword(randomBytes(32).toString('base64url'))
    });
    // Exercise existing finalization only in this owned loopback lab.
    runtime = await startCloudIngest({ config: { ...config, autoFinalizeNewPunches: true }, diagnosticLog: { write() {} } });
    const devicePath = `/iclock/cdata?SN=${SIMULATED_PROFILE_SERIAL}&table=ATTLOG`;
    const finalEventsPath = '/api/v1/final-events?after_id=0&limit=1';
    const request = (path, options) => fetch(apiBase + path, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    assert.equal((await request(finalEventsPath)).status, 401);
    assert.equal((await request(finalEventsPath, { headers: { Authorization: `Bearer ${ingestToken}` } })).status, 401);
    assert.equal((await request('/api/v1/person-directory', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await request(devicePath, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 401);

    async function publishPunch({ timestamp, rawStatus = '1', personCode = SYNTHETIC_PERSON_CODE }) {
      assert.ok(personCodes.includes(personCode));
      const attlog = syntheticAttlog(timestamp, rawStatus);
      const body = personCode + attlog.slice(attlog.indexOf('\t'));
      const receipt = await request(devicePath, { method: 'POST', headers: { Authorization: `Bearer ${ingestToken}` }, body });
      assert.equal(receipt.status, 200);
      assert.equal(await receipt.text(), 'OK: 1');
      const [events] = await lab.sql(`SELECT id, final_event_uuid, person_code FROM \`${T.finalEvents}\`
        WHERE person_code = ? AND event_time_local = ? AND status = 'final'`, [personCode, timestamp]);
      assert.equal(events.length, 1, 'The simulated ATTLOG must produce one final event');
      const [event] = events;
      return { cursor: String(event.id), eventId: event.final_event_uuid, personCode: event.person_code };
    }

    return Object.freeze({ apiBase, token, publishPunch, close });
  } catch (error) {
    await close();
    throw error;
  }
}
