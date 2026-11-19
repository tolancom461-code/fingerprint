import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalIngestMysqlLab } from '../scripts/lib/local-mysql-ingest-lab.mjs';
import { ingestSchemaDefinitions } from '../scripts/test-fixtures/standalone-ingest-fixture.mjs';
import { createIngestDatabase, INGEST_TABLE_PRIVILEGES } from '../src/infrastructure/database/ingest-database.js';
import { TiDbProgramConnectionsStore } from '../src/infrastructure/storage/tidb-program-connections-store.js';
import { ProgramConnectionsService } from '../src/application/program-connections-service.js';

const available = process.platform === 'win32' && await fs.access('C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqld.exe').then(() => true, () => false);

test('owned MySQL validates real program credential SQL through the enabled restricted ingest boundary', {
  skip: available ? false : 'Owned Windows MySQL fixture is unavailable', timeout: 120000,
}, async () => {
  const lab = await createLocalIngestMysqlLab();
  let database;
  let disabled;
  try {
    const [[identity]] = await lab.sql('SELECT @@datadir AS datadir, @@port AS port', [], null);
    assert.equal(path.resolve(identity.datadir), path.resolve(lab.directory, 'data'));
    assert.equal(Number(identity.port), lab.port);
    await lab.sql('CREATE DATABASE fingerprint CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', [], null);
    for (const { ddl } of ingestSchemaDefinitions()) await lab.sql(ddl);
    await lab.sql('ALTER TABLE biometric_svc_event_processing ADD COLUMN automatic_finalization_eligible TINYINT UNSIGNED NOT NULL DEFAULT 0');
    const migration = await fs.readFile(new URL('../database/ADD_PROGRAM_CONNECTIONS_FINGERPRINT_NOT_APPLIED.sql', import.meta.url), 'utf8');
    const ddl = migration.match(/CREATE TABLE `fingerprint`\.`biometric_svc_program_connections` \([\s\S]*?\) ENGINE=InnoDB[^;]*;/g);
    assert.equal(ddl?.length, 1);
    // Execute only CREATE on this verified owned server. Never execute the manual real-account GRANT.
    await lab.sql(ddl[0]);
    const user = `program_test_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(32).toString('hex');
    await lab.sql(`CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY '${password}'`, [], null);
    for (const [table, privileges] of Object.entries(INGEST_TABLE_PRIVILEGES)) {
      await lab.sql(`GRANT ${privileges.join(',')} ON fingerprint.\`${table}\` TO '${user}'@'127.0.0.1'`, [], null);
    }
    await lab.sql(`GRANT SELECT, INSERT, UPDATE ON fingerprint.biometric_svc_program_connections TO '${user}'@'127.0.0.1'`, [], null);
    // Future fixture connections intentionally use another SQL timezone; UTC writes must still be correct.
    await lab.sql("SET GLOBAL time_zone = '+03:00'", [], null);
    const config = { host: '127.0.0.1', port: lab.port, user, password, database: 'fingerprint', confirmedName: 'fingerprint',
      sslMode: 'disabled', connectTimeoutMs: 2000, queryTimeoutMs: 2000, transactionTimeoutMs: 5000 };
    database = await createIngestDatabase({ ...config, programConnectionsEnabled: true });
    const service = new ProgramConnectionsService({ store: new TiDbProgramConnectionsStore(database) });
    assert.deepEqual(await service.assertReady(), { ready: true });
    const before = Date.now();
    const first = await service.create({ programName: 'Synthetic archive consumer', actor: 'fixture-admin' });
    const second = await service.create({ programName: 'Synthetic other consumer', actor: 'fixture-admin' });
    assert.ok(Math.abs(Date.parse(first.connection.createdAtUtc) - before) < 4000);
    assert.equal((await service.authenticate(first.token)).id, first.connection.id);
    assert.equal((await service.authenticate(second.token)).id, second.connection.id);
    const [[stored]] = await lab.sql('SELECT token_hash, token_prefix, status FROM biometric_svc_program_connections WHERE id = ?', [first.connection.id]);
    assert.equal(stored.token_hash, createHash('sha256').update(first.token).digest('hex'));
    assert.equal(stored.token_prefix, first.token.slice(0, 12));
    assert.equal(JSON.stringify(await service.list()).includes(first.token), false);
    const revoked = await service.revoke({ id: first.connection.id, actor: 'fixture-revoker' });
    assert.deepEqual(await service.revoke({ id: first.connection.id, actor: 'another-operator' }), revoked);
    assert.equal(revoked.connection.revokedBy, 'fixture-revoker');
    assert.equal(await service.authenticate(first.token), null);
    assert.equal((await service.authenticate(second.token)).id, second.connection.id);
    disabled = await createIngestDatabase(config);
    await assert.rejects(() => disabled.execute('SELECT id FROM biometric_svc_program_connections'), { code: 'INGEST_DATABASE_QUERY_REJECTED' });
    for (const table of Object.keys(INGEST_TABLE_PRIVILEGES)) {
      const [[row]] = await lab.sql(`SELECT COUNT(*) AS count FROM \`${table}\``);
      assert.equal(Number(row.count), 0);
    }
  } finally {
    await disabled?.end();
    await database?.end();
    const cleanup = await lab.close();
    assert.equal(cleanup.mysqlStopped, true);
    assert.equal(cleanup.initializerStopped, true);
    assert.equal(cleanup.bootstrapRemoved, true);
  }
});
