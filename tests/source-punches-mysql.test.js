import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalIngestMysqlLab } from '../scripts/lib/local-mysql-ingest-lab.mjs';
import { SourcePunchesService } from '../src/application/source-punches-service.js';
import { TiDbSourcePunchesReadStore } from '../src/infrastructure/storage/tidb-source-punches-read-store.js';
import { TiDbProgramConnectionsStore } from '../src/infrastructure/storage/tidb-program-connections-store.js';

const available = process.platform === 'win32'
  && await fs.access('C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqld.exe').then(() => true, () => false);

test('owned MySQL source stream preserves identity/precision and paginates through supported historical rows', {
  skip: available ? false : 'Owned Windows MySQL fixture is unavailable', timeout: 120000,
}, async () => {
  const lab = await createLocalIngestMysqlLab();
  try {
    const [[identity]] = await lab.sql('SELECT @@datadir AS datadir, @@port AS port', [], null);
    assert.equal(path.resolve(identity.datadir), path.resolve(lab.directory, 'data'));
    assert.equal(Number(identity.port), lab.port);
    await lab.sql('CREATE DATABASE `fingerprint` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', [], null);
    await lab.sql(`CREATE TABLE biometric_svc_punches (
      id BIGINT UNSIGNED PRIMARY KEY, event_key CHAR(64) NOT NULL, device_id BIGINT UNSIGNED NOT NULL,
      device_user_id VARCHAR(128) NOT NULL, device_user_row_id BIGINT UNSIGNED NULL,
      vendor VARCHAR(64) NOT NULL, serial_number VARCHAR(128) NOT NULL,
      punch_state VARCHAR(64) NULL, raw_status VARCHAR(32) NULL, device_event_time_utc DATETIME(6) NULL
    ) ENGINE=InnoDB`);
    const states = ['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out'];
    const rows = states.map((state, index) => ({ id: String(9007199254740993n + BigInt(index)),
      state: index === 1 ? null : state, raw: String(index), serial: 'AJE1261900133',
      identity: index === 0 ? null : '18446744073709551615', utc: '2026-11-19 07:08:09.123456' }));
    rows.push(
      { id: '18446744073709551610', state: null, raw: '0', serial: 'UNPROVEN', utc: '2026-11-19 07:08:09' },
      { id: '18446744073709551611', state: 'check_in', raw: '9', serial: 'AJE1261900133', utc: '2026-11-19 07:08:09' },
      { id: '18446744073709551612', state: 'check_in', raw: '1', serial: 'AJE1261900133', utc: '2026-11-19 07:08:09' },
      { id: '18446744073709551613', state: 'check_in', raw: '0', serial: 'AJE1261900133', utc: null },
      { id: '18446744073709551615', state: 'check_out', raw: '1', serial: 'UNPROVEN', utc: '2026-11-19 07:08:09.000001' },
    );
    for (const row of rows) await lab.sql(`INSERT INTO biometric_svc_punches
      (id,event_key,device_id,device_user_id,device_user_row_id,vendor,serial_number,punch_state,raw_status,device_event_time_utc)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [row.id, createHash('sha256').update(row.id).digest('hex'), '9007199254740999',
      '60001', row.identity ?? null, 'zkteco', row.serial, row.state, row.raw, row.utc]);
    const pool = { execute: (sql, params) => lab.sql(sql, params) };
    const service = new SourcePunchesService({ streamId: '1f999b36-e779-429b-b1d4-c6337d1e75c9',
      readStore: new TiDbSourcePunchesReadStore(pool, { deviceUserIdentityEnabled: true }) });
    const items = [];
    let cursor = '0';
    let more;
    do {
      const page = await service.list({ afterId: cursor, limit: 2 });
      items.push(...page.items); cursor = page.nextCursor; more = page.hasMore;
    } while (more);
    assert.equal(items.length, 7);
    assert.deepEqual(items.slice(0, 6).map(item => item.eventType), states);
    assert.equal(items[0].sourceIdentityId, null);
    assert.equal(items[1].sourceIdentityId, '18446744073709551615');
    assert.equal(items[0].sourceDeviceId, '9007199254740999');
    assert.equal(items[0].eventTimeUtc, '2026-11-19T07:08:09.123456Z');
    assert.equal(items.at(-1).eventTimeUtc, '2026-11-19T07:08:09.000001Z');
    assert.equal(cursor, '18446744073709551615');
    const first = await service.list({ limit: 2 });
    assert.deepEqual(await service.list({ limit: 2 }), first);
    const legacy = new SourcePunchesService({ streamId: first.streamId, readStore: new TiDbSourcePunchesReadStore(pool) });
    assert.equal((await legacy.list({ limit: 2 })).items[1].sourceIdentityId, null);
    // Execute only the reviewed CREATE extracted from the manual file, and only
    // after the owned data-directory and port checks above. Never apply GRANTs.
    const manual = await fs.readFile(new URL('../database/ADD_PROGRAM_CONNECTIONS_FINGERPRINT_NOT_APPLIED.sql', import.meta.url), 'utf8');
    const creates = [...manual.matchAll(/CREATE TABLE `fingerprint`\.`biometric_svc_program_connections`\s*\([\s\S]*?;(?=\r?\n)/g)];
    assert.equal(creates.length, 1);
    await lab.sql(creates[0][0]);
    const programStore = new TiDbProgramConnectionsStore(pool);
    assert.deepEqual(await programStore.assertReady(), { ready: true });
    const connection = await programStore.create({ id: '1f999b36-e779-429b-b1d4-c6337d1e75c9',
      programName: 'Synthetic source consumer', tokenHash: 'a'.repeat(64), tokenPrefix: 'abcdefghijkl', actor: 'fixture-admin' });
    assert.equal(connection.programName, 'Synthetic source consumer');
    assert.equal((await programStore.findActiveByTokenHash('a'.repeat(64))).id, connection.id);
    await programStore.revoke({ id: connection.id, actor: 'fixture-admin' });
    assert.equal(await programStore.findActiveByTokenHash('a'.repeat(64)), null);
  } finally {
    const cleanup = await lab.close();
    assert.equal(cleanup.mysqlStopped, true);
    assert.equal(cleanup.initializerStopped, true);
    assert.equal(cleanup.bootstrapRemoved, true);
  }
});
