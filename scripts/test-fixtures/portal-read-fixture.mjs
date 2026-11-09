// NOT FOR PRODUCTION: a synthetic read-contract fixture, not a migration schema.
// This module only constructs SQL/parameters; it has no filesystem, environment,
// network, database connection or execution side effects.
import { createHash } from 'node:crypto';
import {
  BIOMETRIC_TABLES, REQUIRED_BIOMETRIC_COLUMNS, REQUIRED_BIOMETRIC_UNIQUE_INDEXES
} from '../../src/infrastructure/storage/biometric-table-names.js';

export const FIXTURE_VERSION = 'portal-read-fixture-v1';
export const FIXTURE_WARNING = 'NOT FOR PRODUCTION';
export const FIXTURE_MARKER_TABLE = 'biometric_portal_test_identity';
export const FIXTURE_PURPOSE = 'portal-isolated-test-v1';
export const FIXTURE_EVENT_UUID = '48d47491-e7bf-4af5-b617-f361f193f5c4';
export const FIXTURE_DEVICE_ID = '9007199254740993';
export const FIXTURE_PERSON_ID = '9007199254740994';
export const FIXTURE_EVENT_UTC = '2026-11-09T07:15:00.123456Z';
export const FIXTURE_TABLES = Object.freeze([...Object.values(BIOMETRIC_TABLES), FIXTURE_MARKER_TABLE]);

export function fixtureSchemaOperations() {
  const operations = Object.entries(REQUIRED_BIOMETRIC_COLUMNS).map(([table, columns]) => {
    const indexes = REQUIRED_BIOMETRIC_UNIQUE_INDEXES[table] ?? {};
    const primary = indexes.PRIMARY ?? (columns.includes('id') ? ['id'] : []);
    const definitions = columns.map(column => `${fixtureIdentifier(column)} ${columnType(column)} ${primary.includes(column) ? 'NOT NULL' : 'NULL'}`);
    if (primary.length) definitions.push(`PRIMARY KEY (${primary.map(fixtureIdentifier).join(',')})`);
    for (const [name, keys] of Object.entries(indexes)) {
      if (name !== 'PRIMARY') definitions.push(`UNIQUE KEY ${fixtureIdentifier(name)} (${keys.map(fixtureIdentifier).join(',')})`);
    }
    return { name: `create-table:${table}`, method: 'query',
      sql: `CREATE TABLE ${fixtureIdentifier(table)} (${definitions.join(',')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`, params: [] };
  });
  operations.push({ name: `create-table:${FIXTURE_MARKER_TABLE}`, method: 'query',
    sql: 'CREATE TABLE biometric_portal_test_identity (purpose VARCHAR(64) NOT NULL, instance_id VARCHAR(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin', params: [] });
  return operations;
}

export function fixtureSeedOperations(instanceId) {
  if (typeof instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) {
    throw Object.assign(new Error('A UUID4 fixture identity is required'), { code: 'FIXTURE_IDENTITY_INVALID' });
  }
  return [
    { name: 'seed:test-identity', method: 'execute',
      sql: 'INSERT INTO biometric_portal_test_identity (purpose, instance_id) VALUES (?, ?)', params: [FIXTURE_PURPOSE, instanceId] },
    { name: 'seed:test-device', method: 'execute',
      sql: `INSERT INTO ${fixtureIdentifier(BIOMETRIC_TABLES.devices)}
        (id,vendor,serial_number,display_name,model,mode,status,timezone,last_seen_at,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [FIXTURE_DEVICE_ID, 'test-vendor', 'TEST-MYSQL-001', 'جهاز اختبار قاعدة البيانات',
        'Synthetic fixture', 'test', 'active', 'Asia/Riyadh', '2026-11-09 07:00:00', 'FIXTURE-PRIVATE',
        '2026-11-09 07:00:00', '2026-11-09 07:00:00'] },
    { name: 'seed:test-person', method: 'execute',
      sql: `INSERT INTO ${fixtureIdentifier(BIOMETRIC_TABLES.people)}
        (id,person_code,display_name,status,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      params: [FIXTURE_PERSON_ID, 'TEST-100', 'شخص اختبار قاعدة البيانات', 'active', 'FIXTURE-PRIVATE',
        '2026-11-09 07:00:00', '2026-11-09 07:00:00'] },
    { name: 'seed:test-final-event', method: 'execute',
      sql: `INSERT INTO ${fixtureIdentifier(BIOMETRIC_TABLES.finalEvents)}
        (id,final_event_uuid,person_id,person_code,source_punch_id,device_id,event_type,event_time_local,event_timezone,
         event_time_utc,verification_method,finalization_version,status,finalized_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: ['1', FIXTURE_EVENT_UUID, FIXTURE_PERSON_ID, 'TEST-100', '1', FIXTURE_DEVICE_ID, 'break_out',
        '2026-11-09 10:15:00.123456', 'Asia/Riyadh', '2026-11-09 07:15:00.123456', 'card', '1', 'final',
        '2026-11-09 07:15:01', '2026-11-09 07:15:01'] }
  ];
}

export function fixtureIdentifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]+$/.test(value)) {
    throw Object.assign(new Error('Invalid fixture identifier'), { code: 'INVALID_FIXTURE_IDENTIFIER' });
  }
  return `\`${value}\``;
}

export const FIXTURE_SCHEMA_CHECKSUM = createHash('sha256')
  .update(JSON.stringify(fixtureSchemaOperations().map(operation => ({ name: operation.name, sql: operation.sql }))))
  .digest('hex');

function columnType(column) {
  if (column === 'id' || /^(?:ingest_event|source_punch|device|person|device_user_row|entity)_id$/.test(column)) return 'BIGINT UNSIGNED';
  if (column.endsWith('_at') || /_time_(?:local|utc)$/.test(column) || column === 'accept_events_from') return 'DATETIME(6)';
  if (['notes', 'details', 'safe_payload', 'safe_metadata', 'before_state', 'after_state', 'safe_capabilities', 'vendor_metadata', 'last_error_message'].includes(column)) return 'LONGTEXT';
  return 'VARCHAR(128)';
}
