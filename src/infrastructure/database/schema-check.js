import {
  BIOMETRIC_TABLES,
  REQUIRED_BIOMETRIC_COLUMNS,
  REQUIRED_BIOMETRIC_UNIQUE_INDEXES
} from '../storage/biometric-table-names.js';

const DEVICE_USERS = BIOMETRIC_TABLES.deviceUsers;
const PUNCHES = BIOMETRIC_TABLES.punches;
const LEGACY_USER_INDEX = 'uq_biometric_svc_device_user';
const CURRENT_USER_INDEX = 'uq_biometric_svc_device_user_current';
const DEVICE_PIN_LOOKUP = 'idx_biometric_svc_device_users_device_pin';
const PUNCH_USER_LOOKUP = 'idx_biometric_svc_punches_device_user_row_id';
const COLUMN_METADATA = `TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
         DATETIME_PRECISION, CHARACTER_MAXIMUM_LENGTH, COLLATION_NAME, EXTRA, GENERATION_EXPRESSION`;

export async function detectDeviceUserIdentitySchema(pool) {
  const database = await selectedDatabase(pool);
  const tables = [DEVICE_USERS, PUNCHES];
  const [columns, indexes] = await Promise.all([
    loadColumnMetadata(pool, database, tables), loadIndexMetadata(pool, database, tables)
  ]);
  return checkDeviceUserIdentitySchema(collectColumns(columns), collectIndexes(indexes));
}

export async function assertBiometricDatabaseReady(pool, expectedDatabase) {
  const currentDatabase = await selectedDatabase(pool);
  if (expectedDatabase && currentDatabase !== expectedDatabase) {
    throw new Error(`connected to unexpected database: ${currentDatabase}`);
  }

  const tableNames = Object.values(BIOMETRIC_TABLES);
  const placeholders = tableNames.map(() => '?').join(',');
  const foundColumns = collectColumns(await loadColumnMetadata(pool, currentDatabase, tableNames));

  for (const [table, requiredColumns] of Object.entries(REQUIRED_BIOMETRIC_COLUMNS)) {
    const columns = foundColumns.get(table);
    if (!columns) throw new Error(`required biometric table is missing: ${table}`);
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(`biometric table ${table} is missing columns: ${missing.join(', ')}`);
    }
  }

  const [tableRows] = await pool.execute(
    `SELECT TABLE_NAME, TABLE_COLLATION
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN (${placeholders})`,
    [currentDatabase, ...tableNames]
  );
  const collations = new Map(tableRows.map((row) => [row.TABLE_NAME ?? row.table_name, row.TABLE_COLLATION ?? row.table_collation]));
  for (const table of tableNames) {
    if (String(collations.get(table) ?? '').toLowerCase() !== 'utf8mb4_bin') {
      throw new Error(`biometric table ${table} must use utf8mb4_bin collation`);
    }
  }

  const indexes = collectIndexes(await loadIndexMetadata(pool, currentDatabase, tableNames));
  const deviceUserIdentityEnabled = checkDeviceUserIdentitySchema(foundColumns, indexes);
  for (const [table, requiredIndexes] of Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES)) {
    if (table === DEVICE_USERS && deviceUserIdentityEnabled) continue;
    for (const [indexName, requiredColumns] of Object.entries(requiredIndexes)) {
      if (!matchesIndex(indexes.get(`${table}:${indexName}`), true, requiredColumns)) {
        throw new Error(`biometric table ${table} has invalid or missing unique index ${indexName}`);
      }
    }
  }

  return { database: currentDatabase, tableCount: tableNames.length,
    ...(deviceUserIdentityEnabled ? { deviceUserIdentityEnabled: true } : {}) };
}

async function selectedDatabase(pool) {
  const [rows] = await pool.execute('SELECT DATABASE() AS current_database');
  const database = rows?.[0]?.current_database;
  if (!database) throw new Error('database connection has no selected database');
  return database;
}

async function loadColumnMetadata(pool, database, tables) {
  const [rows] = await pool.execute(
    `SELECT ${COLUMN_METADATA}
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN (${tables.map(() => '?').join(',')})
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [database, ...tables]
  );
  return rows;
}

async function loadIndexMetadata(pool, database, tables) {
  const [rows] = await pool.execute(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN (${tables.map(() => '?').join(',')})
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [database, ...tables]
  );
  return rows;
}

function collectColumns(rows) {
  const columns = new Map();
  for (const row of rows) {
    const table = metadataValue(row, 'TABLE_NAME');
    const column = metadataValue(row, 'COLUMN_NAME');
    if (!columns.has(table)) columns.set(table, new Map());
    columns.get(table).set(column, row);
  }
  return columns;
}

function collectIndexes(rows) {
  const indexes = new Map();
  for (const row of rows) {
    const key = `${metadataValue(row, 'TABLE_NAME')}:${metadataValue(row, 'INDEX_NAME')}`;
    const unique = Number(metadataValue(row, 'NON_UNIQUE')) === 0;
    if (!indexes.has(key)) indexes.set(key, { unique, columns: [] });
    indexes.get(key).columns.push(metadataValue(row, 'COLUMN_NAME'));
  }
  return indexes;
}

function checkDeviceUserIdentitySchema(columns, indexes) {
  const users = columns.get(DEVICE_USERS);
  const started = users?.get('identity_started_at');
  const ended = users?.get('identity_ended_at');
  const currentPin = users?.get('current_device_user_id');
  const punchUser = columns.get(PUNCHES)?.get('device_user_row_id');
  const legacyIndex = indexes.get(`${DEVICE_USERS}:${LEGACY_USER_INDEX}`);
  const currentIndex = indexes.get(`${DEVICE_USERS}:${CURRENT_USER_INDEX}`);
  const pinLookup = indexes.get(`${DEVICE_USERS}:${DEVICE_PIN_LOOKUP}`);
  const punchLookup = indexes.get(`${PUNCHES}:${PUNCH_USER_LOOKUP}`);

  if (![started, ended, currentPin, punchUser, currentIndex, pinLookup, punchLookup].some(Boolean) &&
      matchesIndex(legacyIndex, true, ['device_id', 'device_user_id'])) return false;

  if (legacyIndex || !isIdentityTimestamp(started) || !isIdentityTimestamp(ended) ||
      !isCurrentPinColumn(currentPin) || !isPunchIdentityColumn(punchUser) ||
      !matchesIndex(currentIndex, true, ['device_id', 'current_device_user_id']) ||
      !matchesIndex(pinLookup, false, ['device_id', 'device_user_id']) ||
      !matchesIndex(punchLookup, false, ['device_user_row_id'])) {
    throw Object.assign(new Error('device user identity schema is incomplete or inconsistent'), {
      code: 'DEVICE_USER_IDENTITY_SCHEMA_INCOMPLETE'
    });
  }
  return true;
}

function matchesIndex(index, unique, columns) {
  return index?.unique === unique && index.columns.join('|') === columns.join('|');
}

function metadataValue(row, key) { return row?.[key] ?? row?.[key.toLowerCase()]; }
function nullable(row) { return metadataValue(row, 'IS_NULLABLE') === 'YES'; }

function isIdentityTimestamp(row) {
  return nullable(row) && metadataValue(row, 'DATA_TYPE') === 'datetime' &&
    Number(metadataValue(row, 'DATETIME_PRECISION')) === 6;
}

function isCurrentPinColumn(row) {
  if (!nullable(row) || metadataValue(row, 'DATA_TYPE') !== 'varchar' ||
      Number(metadataValue(row, 'CHARACTER_MAXIMUM_LENGTH')) !== 128 ||
      metadataValue(row, 'COLLATION_NAME') !== 'utf8mb4_bin' ||
      !/\bvirtual generated\b/i.test(metadataValue(row, 'EXTRA') ?? '')) return false;
  const expression = String(metadataValue(row, 'GENERATION_EXPRESSION') ?? '').replace(/\\'/g, "'");
  return expression.includes("'absent_from_device'") && expression.toLowerCase()
    .replace(/_(?:utf8mb4|utf8mb3|utf8|binary)(?=')/g, '').replace(/[\s`()]/g, '') ===
    "casewhenstatus='absent_from_device'thennullelsedevice_user_idend";
}

function isPunchIdentityColumn(row) {
  return nullable(row) && /^bigint(?:\(\d+\))? unsigned$/i.test(metadataValue(row, 'COLUMN_TYPE') ?? '');
}
