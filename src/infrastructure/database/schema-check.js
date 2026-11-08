import {
  BIOMETRIC_TABLES,
  REQUIRED_BIOMETRIC_COLUMNS,
  REQUIRED_BIOMETRIC_UNIQUE_INDEXES
} from '../storage/biometric-table-names.js';

export async function assertBiometricDatabaseReady(pool, expectedDatabase) {
  const [databaseRows] = await pool.execute('SELECT DATABASE() AS current_database');
  const currentDatabase = databaseRows?.[0]?.current_database ?? null;
  if (!currentDatabase) throw new Error('database connection has no selected database');
  if (expectedDatabase && currentDatabase !== expectedDatabase) {
    throw new Error(`connected to unexpected database: ${currentDatabase}`);
  }

  const tableNames = Object.values(BIOMETRIC_TABLES);
  const placeholders = tableNames.map(() => '?').join(',');
  const [columnRows] = await pool.execute(
    `SELECT TABLE_NAME, COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN (${placeholders})
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [currentDatabase, ...tableNames]
  );

  const foundColumns = new Map();
  for (const row of columnRows) {
    const table = row.TABLE_NAME ?? row.table_name;
    const column = row.COLUMN_NAME ?? row.column_name;
    if (!foundColumns.has(table)) foundColumns.set(table, new Set());
    foundColumns.get(table).add(column);
  }

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

  const [indexRows] = await pool.execute(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN (${placeholders})
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [currentDatabase, ...tableNames]
  );
  const uniqueIndexes = collectUniqueIndexes(indexRows);
  for (const [table, requiredIndexes] of Object.entries(REQUIRED_BIOMETRIC_UNIQUE_INDEXES)) {
    for (const [indexName, requiredColumns] of Object.entries(requiredIndexes)) {
      const actual = uniqueIndexes.get(`${table}:${indexName}`) ?? [];
      if (actual.join('|') !== requiredColumns.join('|')) {
        throw new Error(`biometric table ${table} has invalid or missing unique index ${indexName}`);
      }
    }
  }

  return { database: currentDatabase, tableCount: tableNames.length };
}

function collectUniqueIndexes(rows) {
  const indexes = new Map();
  for (const row of rows) {
    const nonUnique = Number(row.NON_UNIQUE ?? row.non_unique);
    if (nonUnique !== 0) continue;
    const table = row.TABLE_NAME ?? row.table_name;
    const index = row.INDEX_NAME ?? row.index_name;
    const column = row.COLUMN_NAME ?? row.column_name;
    const key = `${table}:${index}`;
    if (!indexes.has(key)) indexes.set(key, []);
    indexes.get(key).push(column);
  }
  return indexes;
}
