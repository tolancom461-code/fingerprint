import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MIGRATION_TABLES, BACKUP_TABLES, encodeValue, decodeValue, serializeRow,
  deserializeRow, canonicalRowsHash, validateTableDdl
} from '../scripts/lib/biometric-backup-format.mjs';
import { BIOMETRIC_TABLES } from '../src/infrastructure/storage/biometric-table-names.js';
import { fixtureSchemaOperations } from '../scripts/test-fixtures/portal-read-fixture.mjs';

// SHOW CREATE TABLE snapshots of source-owned tables only. No rows, connection
// details or source schema names are included, and tests do not read live files.
const sourceDdls = [
  {
    "table": "biometric_svc_audit_log",
    "ddl": "CREATE TABLE `biometric_svc_audit_log` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `actor_type` varchar(32) NOT NULL,\n  `actor_reference` varchar(128) DEFAULT NULL,\n  `action_type` varchar(64) NOT NULL,\n  `entity_type` varchar(64) NOT NULL,\n  `entity_id` bigint unsigned DEFAULT NULL,\n  `before_state` json DEFAULT NULL,\n  `after_state` json DEFAULT NULL,\n  `notes` varchar(1000) DEFAULT NULL,\n  `occurred_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  KEY `idx_biometric_svc_audit_log_actor` (`actor_type`,`actor_reference`),\n  KEY `idx_biometric_svc_audit_log_action` (`action_type`),\n  KEY `idx_biometric_svc_audit_log_entity` (`entity_type`,`entity_id`),\n  KEY `idx_biometric_svc_audit_log_occurred_at` (`occurred_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=120001"
  },
  {
    "table": "biometric_svc_device_users",
    "ddl": "CREATE TABLE `biometric_svc_device_users` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `device_id` bigint unsigned NOT NULL,\n  `device_user_id` varchar(128) NOT NULL,\n  `display_name` varchar(255) DEFAULT NULL,\n  `status` varchar(32) NOT NULL DEFAULT 'seen',\n  `metadata_schema_version` smallint unsigned NOT NULL DEFAULT '1',\n  `safe_metadata` json DEFAULT NULL,\n  `first_seen_at` datetime(6) DEFAULT NULL,\n  `last_seen_at` datetime(6) DEFAULT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  UNIQUE KEY `uq_biometric_svc_device_user` (`device_id`,`device_user_id`),\n  KEY `idx_biometric_svc_device_users_status` (`device_id`,`status`),\n  KEY `idx_biometric_svc_device_users_last_seen` (`last_seen_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=5285036"
  },
  {
    "table": "biometric_svc_devices",
    "ddl": "CREATE TABLE `biometric_svc_devices` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `vendor` varchar(64) NOT NULL,\n  `serial_number` varchar(128) NOT NULL,\n  `display_name` varchar(255) DEFAULT NULL,\n  `manufacturer` varchar(128) DEFAULT NULL,\n  `model` varchar(128) DEFAULT NULL,\n  `protocol` varchar(64) DEFAULT NULL,\n  `adapter_type` varchar(64) DEFAULT NULL,\n  `mode` varchar(32) NOT NULL DEFAULT 'test',\n  `status` varchar(32) NOT NULL DEFAULT 'active',\n  `timezone` varchar(100) NOT NULL DEFAULT 'Asia/Riyadh',\n  `accept_events_from` datetime(6) DEFAULT NULL,\n  `firmware_version` varchar(160) DEFAULT NULL,\n  `platform` varchar(128) DEFAULT NULL,\n  `oem_vendor` varchar(128) DEFAULT NULL,\n  `first_seen_at` datetime(6) DEFAULT NULL,\n  `last_seen_at` datetime(6) DEFAULT NULL,\n  `last_event_at` datetime(6) DEFAULT NULL,\n  `last_ip_address` varchar(45) DEFAULT NULL,\n  `safe_capabilities` json DEFAULT NULL,\n  `notes` text DEFAULT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  UNIQUE KEY `uq_biometric_svc_devices_vendor_serial` (`vendor`,`serial_number`),\n  KEY `idx_biometric_svc_devices_status` (`status`),\n  KEY `idx_biometric_svc_devices_last_seen` (`last_seen_at`),\n  KEY `idx_biometric_svc_devices_last_event` (`last_event_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=8374556"
  },
  {
    "table": "biometric_svc_event_processing",
    "ddl": "CREATE TABLE `biometric_svc_event_processing` (\n  `ingest_event_id` bigint unsigned NOT NULL,\n  `status` varchar(32) NOT NULL DEFAULT 'pending',\n  `attempt_count` int unsigned NOT NULL DEFAULT '0',\n  `next_attempt_at` datetime(6) DEFAULT NULL,\n  `last_attempt_at` datetime(6) DEFAULT NULL,\n  `lease_owner` varchar(128) DEFAULT NULL,\n  `lease_token` char(36) DEFAULT NULL,\n  `lease_expires_at` datetime(6) DEFAULT NULL,\n  `last_error_code` varchar(100) DEFAULT NULL,\n  `last_error_message` varchar(1000) DEFAULT NULL,\n  `processed_at` datetime(6) DEFAULT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`ingest_event_id`) /*T![clustered_index] CLUSTERED */,\n  KEY `idx_biometric_svc_processing_work` (`status`,`next_attempt_at`,`lease_expires_at`),\n  KEY `idx_biometric_svc_processing_lease` (`lease_token`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin"
  },
  {
    "table": "biometric_svc_final_events",
    "ddl": "CREATE TABLE `biometric_svc_final_events` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `final_event_uuid` char(36) NOT NULL,\n  `person_id` bigint unsigned NOT NULL,\n  `person_code` varchar(64) NOT NULL,\n  `source_punch_id` bigint unsigned NOT NULL,\n  `device_id` bigint unsigned NOT NULL,\n  `device_reference` varchar(255) NOT NULL,\n  `event_type` varchar(64) NOT NULL,\n  `event_time_local` datetime(6) NOT NULL,\n  `event_timezone` varchar(100) NOT NULL,\n  `event_time_utc` datetime(6) NOT NULL,\n  `verification_method` varchar(64) DEFAULT NULL,\n  `finalization_version` varchar(32) NOT NULL,\n  `status` varchar(32) NOT NULL DEFAULT 'final',\n  `safe_metadata` json DEFAULT NULL,\n  `finalized_at` datetime(6) NOT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  UNIQUE KEY `uq_biometric_svc_final_events_uuid` (`final_event_uuid`),\n  UNIQUE KEY `uq_biometric_svc_final_events_source_version` (`source_punch_id`,`finalization_version`),\n  KEY `idx_biometric_svc_final_events_person_time` (`person_id`,`event_time_utc`),\n  KEY `idx_biometric_svc_final_events_person_code_time` (`person_code`,`event_time_utc`),\n  KEY `idx_biometric_svc_final_events_device_time` (`device_id`,`event_time_utc`),\n  KEY `idx_biometric_svc_final_events_status_finalized` (`status`,`finalized_at`),\n  KEY `idx_biometric_svc_final_events_event_time_utc` (`event_time_utc`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=360001"
  },
  {
    "table": "biometric_svc_finalization_issues",
    "ddl": "CREATE TABLE `biometric_svc_finalization_issues` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `source_punch_id` bigint unsigned NOT NULL,\n  `issue_type` varchar(64) NOT NULL,\n  `status` varchar(32) NOT NULL DEFAULT 'open',\n  `details` json DEFAULT NULL,\n  `first_seen_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `last_seen_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `resolved_at` datetime(6) DEFAULT NULL,\n  `resolution_note` varchar(1000) DEFAULT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  UNIQUE KEY `uq_biometric_svc_finalization_issues_source_type` (`source_punch_id`,`issue_type`),\n  KEY `idx_biometric_svc_finalization_issues_status` (`status`),\n  KEY `idx_biometric_svc_finalization_issues_type_status` (`issue_type`,`status`),\n  KEY `idx_biometric_svc_finalization_issues_last_seen` (`last_seen_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=420001"
  },
  {
    "table": "biometric_svc_ingest_events",
    "ddl": "CREATE TABLE `biometric_svc_ingest_events` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `ingest_key` char(64) NOT NULL,\n  `storage_identity_version` varchar(32) NOT NULL,\n  `device_id` bigint unsigned NOT NULL,\n  `vendor` varchar(64) NOT NULL,\n  `serial_number` varchar(128) NOT NULL,\n  `event_family` varchar(64) NOT NULL,\n  `vendor_event_type` varchar(64) NOT NULL,\n  `vendor_event_id` varchar(255) DEFAULT NULL,\n  `dedupe_key` varchar(255) NOT NULL,\n  `dedupe_strategy` varchar(100) NOT NULL,\n  `dedupe_version` varchar(32) NOT NULL,\n  `wire_hash` char(64) NOT NULL,\n  `capture_id` char(36) DEFAULT NULL,\n  `capture_index` int unsigned DEFAULT NULL,\n  `adapter_version` varchar(128) DEFAULT NULL,\n  `parser_version` varchar(128) NOT NULL,\n  `parse_valid` tinyint unsigned NOT NULL,\n  `safe_to_acknowledge` tinyint unsigned NOT NULL,\n  `unsafe_reason` varchar(255) DEFAULT NULL,\n  `source_bytes` int unsigned DEFAULT NULL,\n  `source_field_count` smallint unsigned DEFAULT NULL,\n  `payload_schema_version` smallint unsigned NOT NULL DEFAULT '1',\n  `safe_payload` json DEFAULT NULL,\n  `source_ip` varchar(45) DEFAULT NULL,\n  `received_at` datetime(6) NOT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  UNIQUE KEY `uq_biometric_svc_ingest_key` (`ingest_key`),\n  UNIQUE KEY `uq_biometric_svc_ingest_vendor_identity` (`device_id`,`dedupe_strategy`,`dedupe_version`,`dedupe_key`),\n  KEY `idx_biometric_svc_ingest_device_received` (`device_id`,`received_at`),\n  KEY `idx_biometric_svc_ingest_wire_hash` (`wire_hash`),\n  KEY `idx_biometric_svc_ingest_capture` (`capture_id`),\n  KEY `idx_biometric_svc_ingest_ack` (`safe_to_acknowledge`,`received_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=6256006"
  },
  {
    "table": "biometric_svc_people",
    "ddl": "CREATE TABLE `biometric_svc_people` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `person_code` varchar(64) NOT NULL,\n  `display_name` varchar(255) NOT NULL,\n  `status` varchar(32) NOT NULL DEFAULT 'active',\n  `notes` text DEFAULT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  UNIQUE KEY `uq_biometric_svc_people_person_code` (`person_code`),\n  KEY `idx_biometric_svc_people_status` (`status`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=120001"
  },
  {
    "table": "biometric_svc_person_device_users",
    "ddl": "CREATE TABLE `biometric_svc_person_device_users` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `person_id` bigint unsigned NOT NULL,\n  `device_user_row_id` bigint unsigned NOT NULL,\n  `status` varchar(32) NOT NULL DEFAULT 'active',\n  `active_from` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `active_to` datetime(6) DEFAULT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  UNIQUE KEY `uq_biometric_svc_person_device_users_device_user` (`device_user_row_id`),\n  KEY `idx_biometric_svc_person_device_users_person` (`person_id`),\n  KEY `idx_biometric_svc_person_device_users_status` (`status`),\n  KEY `idx_biometric_svc_person_device_users_active` (`person_id`,`status`,`active_to`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=120001"
  },
  {
    "table": "biometric_svc_punches",
    "ddl": "CREATE TABLE `biometric_svc_punches` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `ingest_event_id` bigint unsigned NOT NULL,\n  `event_key` char(64) NOT NULL,\n  `event_key_strategy` varchar(100) NOT NULL,\n  `event_key_version` varchar(32) NOT NULL,\n  `vendor_dedupe_key` varchar(255) NOT NULL,\n  `vendor_dedupe_strategy` varchar(100) NOT NULL,\n  `vendor_dedupe_version` varchar(32) NOT NULL,\n  `device_id` bigint unsigned NOT NULL,\n  `vendor` varchar(64) NOT NULL,\n  `serial_number` varchar(128) NOT NULL,\n  `device_user_id` varchar(128) NOT NULL,\n  `device_event_time_raw` varchar(64) NOT NULL,\n  `device_event_time_local` datetime(6) NOT NULL,\n  `device_timezone` varchar(100) DEFAULT NULL,\n  `device_event_time_utc` datetime(6) DEFAULT NULL,\n  `raw_status` varchar(32) DEFAULT NULL,\n  `punch_state` varchar(64) DEFAULT NULL,\n  `raw_verify` varchar(32) DEFAULT NULL,\n  `verification_method` varchar(64) DEFAULT NULL,\n  `work_code` varchar(100) DEFAULT NULL,\n  `canonical_schema_version` smallint unsigned NOT NULL DEFAULT '1',\n  `vendor_metadata` json DEFAULT NULL,\n  `wire_hash` char(64) NOT NULL,\n  `parser_version` varchar(128) NOT NULL,\n  `received_at` datetime(6) NOT NULL,\n  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),\n  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,\n  UNIQUE KEY `uq_biometric_svc_punch_ingest` (`ingest_event_id`),\n  UNIQUE KEY `uq_biometric_svc_punch_event` (`event_key`),\n  KEY `idx_biometric_svc_punch_device_time` (`device_id`,`device_event_time_local`),\n  KEY `idx_biometric_svc_punch_user_time` (`device_id`,`device_user_id`,`device_event_time_local`),\n  KEY `idx_biometric_svc_punch_utc` (`device_event_time_utc`),\n  KEY `idx_biometric_svc_punch_received` (`received_at`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=5389673"
  }
];

test('migration table ownership is exactly ten service tables; backup permits only the destination marker in addition', () => {
  assert.deepEqual(MIGRATION_TABLES, Object.values(BIOMETRIC_TABLES));
  assert.equal(MIGRATION_TABLES.length, 10);
  assert.equal(BACKUP_TABLES.length, 11);
  assert.equal(Object.isFrozen(MIGRATION_TABLES), true);
  assert.equal(Object.isFrozen(BACKUP_TABLES), true);
  assert.equal(MIGRATION_TABLES.includes('biometric_portal_test_identity'), false);
  assert.equal(BACKUP_TABLES.at(-1), 'biometric_portal_test_identity');
});

test('typed encoding survives JSON storage without changing supported SQL values', () => {
  const values = [null, true, false, '', '000123', '900719925474099312345',
    '2026-11-09 07:15:00.123456', '{"b":2,"a":9007199254740993}', 'نص عربي\n\u0000',
    0, -0, 1.25, Number.MIN_VALUE, Number.MAX_VALUE, 9007199254740993n, -12345678901234567890n,
    Buffer.alloc(0), Buffer.from([0, 1, 127, 128, 255])];
  for (const value of values) {
    const restored = decodeValue(JSON.parse(JSON.stringify(encodeValue(value))));
    if (Buffer.isBuffer(value)) assert.deepEqual(restored, value);
    else assert.equal(Object.is(restored, value), true);
  }
});

test('unsupported or malformed encoded values fail rather than silently losing precision or type', () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, new Date(), {}, [], new Uint8Array([1]), () => {}]) {
    assert.throws(() => encodeValue(value), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
  }
  for (const value of [null, [], { type: 'unknown', value: 1 }, { type: 'null', value: null },
    { type: 'number', value: 1 }, { type: 'number', value: '01' }, { type: 'number', value: 'Infinity' },
    { type: 'bigint', value: '+1' }, { type: 'bigint', value: '01' }, { type: 'bigint', value: '-0' },
    { type: 'buffer', value: 'AA' }, { type: 'buffer', value: 'AB==' }, { type: 'buffer', value: 'AA==\n' },
    { type: 'string', value: 1 }, { type: 'boolean', value: 'true' }, { type: 'string', value: 'x', extra: 1 }]) {
    assert.throws(() => decodeValue(value), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
  }
});

test('row serialization follows explicit columns and deserialization supplies original INSERT values', () => {
  const columns = ['id', 'observed_at', 'payload', 'bytes', 'optional'];
  const row = { bytes: Buffer.from([0, 255]), payload: '{"n":9007199254740993}',
    id: '9007199254740993', observed_at: '2026-11-09 07:15:00.123456', optional: null, ignored: 'not included' };
  const encoded = serializeRow(row, columns);
  assert.deepEqual(deserializeRow(JSON.parse(JSON.stringify(encoded))), columns.map(name => row[name]));
  assert.equal(JSON.stringify(encoded).includes('not included'), false);
  for (const badColumns of [null, [], ['id', 'id'], [1], ['']]) {
    assert.throws(() => serializeRow(row, badColumns), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
  }
  assert.throws(() => serializeRow({}, ['missing']), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
  assert.throws(() => serializeRow({ id: undefined }, ['id']), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
  assert.throws(() => deserializeRow({}), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
});

test('canonical hash is stable across object field order and encoded round trip but detects row, type, column and exact JSON changes', () => {
  const columns = ['id', 'payload'];
  const rows = [{ payload: '{"b":2,"a":1}', id: '1' }, { id: '2', payload: null }];
  const hash = canonicalRowsHash(columns, rows);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, canonicalRowsHash(columns, [{ id: '1', payload: '{"b":2,"a":1}' }, rows[1]]));
  const restored = rows.map(row => Object.fromEntries(columns.map((column, index) =>
    [column, deserializeRow(JSON.parse(JSON.stringify(serializeRow(row, columns))))[index]])));
  assert.equal(hash, canonicalRowsHash(columns, restored));
  assert.notEqual(hash, canonicalRowsHash(columns, [...rows].reverse()));
  assert.notEqual(hash, canonicalRowsHash(columns, [{ id: 1, payload: rows[0].payload }, rows[1]]));
  assert.notEqual(hash, canonicalRowsHash(columns, [{ id: '1', payload: '{"a":1,"b":2}' }, rows[1]]));
  assert.notEqual(hash, canonicalRowsHash([...columns].reverse(), rows));
  assert.notEqual(canonicalRowsHash(['id'], []), canonicalRowsHash(['other'], []));
  assert.equal(canonicalRowsHash(['id'], []), createHash('sha256')
    .update('biometric-backup-rows-v1\n["id"]\n').digest('hex'));
});

test('all ten source SHOW CREATE statements validate unchanged, and the test marker backup is also accepted', () => {
  assert.equal(sourceDdls.length, 10);
  assert.deepEqual(sourceDdls.map(item => item.table).sort(), [...MIGRATION_TABLES].sort());
  for (const { table, ddl } of sourceDdls) assert.equal(validateTableDdl(ddl, table), ddl);
  const marker = fixtureSchemaOperations().find(operation => operation.name.endsWith('biometric_portal_test_identity'));
  assert.equal(validateTableDdl(marker.sql, 'biometric_portal_test_identity'), marker.sql);
});

test('DDL validation preserves TiDB options, normal comments and keywords inside quoted literals', () => {
  const table = MIGRATION_TABLES[0];
  const ddl = `/* ordinary DROP comment */ CREATE TABLE \`${table}\` (
    \`id\` bigint NOT NULL, \`text\` varchar(255) DEFAULT 'DROP; INSERT; REFERENCES schema.table',
    \`updated_at\` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`test_check\` CHECK (\`text\` <> 'ALTER TABLE x;'),
    PRIMARY KEY (\`id\`) /*T![clustered_index] CLUSTERED */
  ) ENGINE=InnoDB COMMENT='quoted; \\'DROP\\' and REFERENCES' /*T![auto_id_cache] AUTO_ID_CACHE=1 */`;
  assert.equal(validateTableDdl(ddl, table), ddl);
});

test('DDL validation rejects wrong or qualified targets, cloning and all additional statements', () => {
  const table = MIGRATION_TABLES[0];
  const prefix = `CREATE TABLE \`${table}\` (\`id\` bigint)`;
  for (const ddl of [
    'DROP DATABASE fingerprint', `CREATE TABLE \`other\` (id int)`,
    `CREATE TABLE \`test\`.\`${table}\` (id int)`, `CREATE TABLE test.\`${table}\` (id int)`,
    `CREATE TABLE IF NOT EXISTS \`${table}\` (id int)`, `CREATE TEMPORARY TABLE \`${table}\` (id int)`,
    `CREATE TABLE \`${table}\` LIKE other`, `${prefix} AS SELECT * FROM other`, `${prefix} LIKE other`,
    `${prefix};`, `${prefix}; DROP TABLE other`, `${prefix} INSERT INTO other VALUES (1)`,
    `${prefix} ALTER TABLE other ADD x int`, `${prefix} RENAME TO other`,
    `${prefix} UNION=(other)`, `${prefix} DATA DIRECTORY='/tmp'`,
    `CREATE TABLE \`${table}\` (id int, FOREIGN KEY (id) REFERENCES \`biometric_svc_people\` (id))`,
    `CREATE TABLE \`${table}\` (id int, FOREIGN KEY (id) REFERENCES test.people(id))`
  ]) assert.throws(() => validateTableDdl(ddl, table), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
  assert.throws(() => validateTableDdl(prefix, 'workers'), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
});

test('DDL validation rejects executable MySQL comments, destructive TiDB payloads and malformed lexical structure', () => {
  const table = MIGRATION_TABLES[0];
  const prefix = `CREATE TABLE \`${table}\` (\`id\` bigint)`;
  for (const ddl of [`${prefix} /*!50100 DROP TABLE other */`,
    `${prefix} /*T![metadata] DROP TABLE other */`, `${prefix} /*T![metadata] SET sql_mode='' */`,
    `${prefix} /*T![metadata] SELECT 1 */`, `${prefix} /*T![metadata] AUTO_ID_CACHE=1; DROP TABLE other */`,
    `${prefix} /* unclosed`, `${prefix} COMMENT='unclosed`, `CREATE TABLE \`${table}\` (id int`,
    `${prefix})`, `${prefix}\u0000`, `${prefix} /* nested /* comment */`
  ]) assert.throws(() => validateTableDdl(ddl, table), { code: 'BIOMETRIC_BACKUP_FORMAT_INVALID' });
});
