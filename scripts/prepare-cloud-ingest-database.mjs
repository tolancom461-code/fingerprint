// Explicit destination-only preparation. Default --plan sends SELECT/SHOW only.
// Apply is additive: fresh verified backup, optional eligibility column, and a
// new least-privilege writer. It never starts ingest or changes existing users.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { BIOMETRIC_TABLES } from '../src/infrastructure/storage/biometric-table-names.js';
import { assertBiometricDatabaseReady } from '../src/infrastructure/database/schema-check.js';
import { createIngestDatabase, INGEST_TABLE_PRIVILEGES } from '../src/infrastructure/database/ingest-database.js';
import { exportBiometricBackup } from './lib/biometric-readonly-export.mjs';
import { canonicalRowsHash, deserializeRow, validateTableDdl } from './lib/biometric-backup-format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = 'fingerprint';
const names = Object.freeze(Object.values(BIOMETRIC_TABLES));
const processing = BIOMETRIC_TABLES.eventProcessing;
const eligibility = 'automatic_finalization_eligible';
const addColumnSql = 'ALTER TABLE `fingerprint`.`biometric_svc_event_processing` ADD COLUMN `automatic_finalization_eligible` TINYINT UNSIGNED NOT NULL DEFAULT 0';
const privateFiles = Object.freeze({
  async exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
  async writeExclusive(file, text) { await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 }); },
  async readText(file) { return fs.readFile(file, 'utf8'); },
  async createBackupDirectory(parent) { await fs.mkdir(parent, { recursive: true }); return fs.mkdtemp(path.join(parent, 'cloud-ingest-backup-')); },
  async writeReport(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
});

export async function prepareCloudIngestDatabase({ env = process.env, apply = false,
  createConnection = mysql.createConnection, verifyWriter = verifyRuntimeWriter,
  exportBackup = exportBiometricBackup, fileStore = privateFiles,
  backupDirectoryParent = path.join(root, 'verification'), privateEnvPath = path.join(root, '.env.ingest-database.tidb'),
  reportPath = path.join(root, 'verification', 'cloud-ingest-db-setup-2026-11-09.json'),
  connectTimeoutMs = 6000, queryTimeoutMs = 5000 } = {}) {
  const report = { startedAtUtc: new Date().toISOString(), mode: apply ? 'apply' : 'plan', destination: target,
    passed: false, changesApplied: false, sourceConnectionsOpened: 0, existingAccountsChanged: false,
    ingestActivated: false, railwayOrDeviceChanged: false, automaticDeletionOrRollback: false,
    partialPreparationPossible: false, attemptedOperations: [], completedOperations: [], cleanup: {} };
  let connection;
  let stage = 'validate-input';
  let activeOperation = null;
  const raw = (sql, params = [], method = 'execute') => bounded(
    Promise.resolve().then(() => connection[method]({ sql, timeout: queryTimeoutMs }, params)),
    queryTimeoutMs, () => connection.destroy(), 'CLOUD_INGEST_QUERY_TIMEOUT');
  const read = (sql, params = [], method = 'execute') => {
    if (typeof sql !== 'string' || !/^(?:SELECT|SHOW CREATE TABLE|SHOW GRANTS)\b/.test(sql) || /\0|;|--|#|\/\*|:=/.test(sql) ||
        /\bINTO\b|\bFOR\s+(?:UPDATE|SHARE)\b|\b(?:LOAD_FILE|GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\s*\(/i.test(sql)) {
      throw failure('CLOUD_INGEST_READ_QUERY_REJECTED');
    }
    return raw(sql, params, method);
  };
  const save = async () => { report.updatedAtUtc = new Date().toISOString(); await fileStore.writeReport(reportPath, JSON.stringify(report, null, 2)); };
  const mutate = async (name, sql) => {
    activeOperation = name; report.attemptedOperations.push(name); report.partialPreparationPossible = true;
    await save();
    await raw(sql, [], 'query');
    report.completedOperations.push(name); report.changesApplied = true; activeOperation = null;
    await save();
  };
  const inspect = async () => {
    const [selected] = await read('SELECT DATABASE() AS current_database');
    if (!Array.isArray(selected) || selected.length !== 1 || selected[0]?.current_database !== target) throw failure('CLOUD_INGEST_TARGET_REJECTED');
    const [tables] = await read('SELECT TABLE_NAME,TABLE_TYPE,AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [target]);
    if (!Array.isArray(tables) || tables.length !== names.length || new Set(tables.map(row => row?.TABLE_NAME)).size !== names.length ||
        tables.some(row => row?.TABLE_TYPE !== 'BASE TABLE' || !names.includes(row.TABLE_NAME))) throw failure('CLOUD_INGEST_TABLE_SET_REJECTED');
    return tables;
  };
  const columnState = async () => {
    const [rows] = await read('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [target, processing, eligibility]);
    if (!Array.isArray(rows) || rows.length > 1) throw failure('CLOUD_INGEST_ELIGIBILITY_COLUMN_INVALID');
    if (!rows.length) return false;
    const column = rows[0];
    if (column.COLUMN_NAME !== eligibility || !/^tinyint(?:\([0-9]+\))? unsigned$/i.test(String(column.COLUMN_TYPE ?? '').trim()) ||
        column.IS_NULLABLE !== 'NO' || String(column.COLUMN_DEFAULT) !== '0' || String(column.EXTRA ?? '').trim() !== '') {
      throw failure('CLOUD_INGEST_ELIGIBILITY_COLUMN_INVALID');
    }
    return true;
  };
  const verifyOldState = async (manifest, added) => {
    const metadata = await inspect();
    for (const table of manifest.tables) {
      const [rows] = await read(`SELECT ${table.columns.map(identifier).join(',')} FROM \`fingerprint\`.${identifier(table.name)} ORDER BY ${identifier(table.primaryKey)}`);
      if (!Array.isArray(rows) || rows.length !== table.rowCount || canonicalRowsHash(table.columns, rows) !== table.rowsSha256) {
        throw failure('CLOUD_INGEST_EXISTING_DATA_CHANGED');
      }
      const [definitions] = await read(`SHOW CREATE TABLE \`fingerprint\`.${identifier(table.name)}`, [], 'query');
      const ddl = Array.isArray(definitions) && definitions.length === 1 ? definitions[0]?.['Create Table'] : null;
      try { validateTableDdl(ddl, table.name); } catch { throw failure('CLOUD_INGEST_EXISTING_DDL_CHANGED'); }
      const comparable = added && table.name === processing ? removeEligibilityDefinition(ddl) : ddl;
      const currentDdl = ddlState(comparable);
      if (currentDdl.normalized !== ddlState(table.ddl).normalized) throw failure('CLOUD_INGEST_EXISTING_DDL_CHANGED');
      if (table.autoIncrement !== null) {
        // TiDB information_schema exposes the local allocator's Base()+1 (or
        // zero when uncached). SHOW CREATE reads NextGlobalAutoID(), including
        // reserved ranges. Compare like-for-like with the backup's high mark;
        // a lower local cache alone is not a counter regression. The global
        // counter must itself remain safe, so MAX cannot hide a global rebase.
        const local = metadata.find(row => row.TABLE_NAME === table.name)?.AUTO_INCREMENT;
        const global = currentDdl.autoIncrement ?? '1'; // TiDB omits the option at one.
        if (!isCounter(local, true) || !isCounter(global, false)) throw failure('CLOUD_INGEST_COUNTER_CHANGED_UNSAFELY');
        const globalNext = BigInt(global), localNext = BigInt(local);
        const effectiveNext = globalNext > localNext ? globalNext : localNext;
        if (globalNext < BigInt(table.autoIncrement) || effectiveNext < BigInt(table.autoIncrement) ||
            (table.maxKey !== null && globalNext <= BigInt(table.maxKey))) throw failure('CLOUD_INGEST_COUNTER_CHANGED_UNSAFELY');
      }
    }
    return true;
  };

  try {
    if (typeof apply !== 'boolean' || typeof createConnection !== 'function' || typeof verifyWriter !== 'function' || typeof exportBackup !== 'function' ||
        !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 6000 ||
        !Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 5000 ||
        !fileStore || ['exists', 'writeExclusive', 'readText', 'createBackupDirectory', 'writeReport'].some(key => typeof fileStore[key] !== 'function')) {
      throw failure('CLOUD_INGEST_INPUT_INVALID');
    }
    validateMatrix();
    const config = configuration(env);
    if (apply && await fileStore.exists(privateEnvPath)) throw failure('CLOUD_INGEST_PRIVATE_ENV_EXISTS');
    stage = 'connect-destination-setup';
    let expired = false;
    connection = await bounded(Promise.resolve().then(() => createConnection({ host: config.host, port: config.port,
      user: config.user, password: config.password, database: target, connectTimeout: connectTimeoutMs,
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true,
      multipleStatements: false, flags: '-LOCAL_FILES', ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true, verifyIdentity: true }
    })).then(opened => { if (expired) opened.destroy(); return opened; }), connectTimeoutMs, () => { expired = true; }, 'CLOUD_INGEST_CONNECT_TIMEOUT');
    connection.on?.('error', () => {});
    stage = 'inspect-destination';
    await inspect();
    await assertBiometricDatabaseReady({ execute: read }, target);
    const existed = await columnState();
    const [roles] = await read('SELECT CURRENT_ROLE() AS active_roles');
    if (!Array.isArray(roles) || roles.length !== 1 || String(roles[0]?.active_roles ?? '').toUpperCase() !== 'NONE') throw failure('CLOUD_INGEST_SETUP_ROLE_REJECTED');
    const [grants] = await read('SHOW GRANTS FOR CURRENT_USER()', [], 'query');
    if (!setupPrivileges(grants, !existed)) throw failure('CLOUD_INGEST_SETUP_PRIVILEGES_REJECTED');
    report.preflight = { selectedDatabaseVerified: true, exactTenTablesVerified: true, schemaContractVerified: true,
      eligibilityColumnAlreadyPresent: existed, setupRoleNone: true, setupPrivilegesVerified: true };
    report.plan = { freshConsistentTypedBackupBeforeMutations: true, addEligibilityColumn: !existed,
      newWriterAccount: true, grants: INGEST_TABLE_PRIVILEGES, automaticCaptureOrDeliveryEnabled: false,
      credentialFile: '.env.ingest-database.tidb', originalRowsMustRemainUnchanged: true };
    if (!apply) { report.passed = true; return report; }

    stage = 'back-up-current-destination';
    const backupDirectory = await fileStore.createBackupDirectory(backupDirectoryParent);
    const manifest = await exportBackup({ connection: { execute: read, query: (sql, params = []) => read(sql, params, 'query') },
      schema: target, purpose: 'standalone-destination',
      writeRowsFile: (name, rows) => fileStore.writeExclusive(backupFile(backupDirectory, name), JSON.stringify(rows)) });
    const manifestText = JSON.stringify(manifest, null, 2);
    await fileStore.writeExclusive(path.join(backupDirectory, 'manifest.json'), manifestText);
    const manifestHash = sha(manifestText);
    const savedText = await fileStore.readText(path.join(backupDirectory, 'manifest.json'));
    if (sha(savedText) !== manifestHash) throw failure('CLOUD_INGEST_BACKUP_MANIFEST_CHANGED');
    const saved = JSON.parse(savedText);
    validateManifest(saved);
    for (const table of saved.tables) {
      const encoded = JSON.parse(await fileStore.readText(backupFile(backupDirectory, table.rowsFile)));
      if (!Array.isArray(encoded) || encoded.length !== table.rowCount) throw failure('CLOUD_INGEST_BACKUP_ROWS_INVALID');
      const rows = encoded.map(values => {
        const decoded = deserializeRow(values);
        if (decoded.length !== table.columns.length) throw failure('CLOUD_INGEST_BACKUP_ROWS_INVALID');
        return Object.fromEntries(table.columns.map((name, index) => [name, decoded[index]]));
      });
      if (canonicalRowsHash(table.columns, rows) !== table.rowsSha256) throw failure('CLOUD_INGEST_BACKUP_HASH_MISMATCH');
    }
    report.backup = { directory: path.relative(root, backupDirectory).replaceAll('\\', '/'), manifestSha256: manifestHash,
      snapshotAt: saved.snapshotAt, consistentSnapshot: true, fileHashesVerified: true, restoreRehearsalPerformed: false,
      counts: Object.fromEntries(saved.tables.map(table => [table.name, table.rowCount])),
      rowsSha256: Object.fromEntries(saved.tables.map(table => [table.name, table.rowsSha256])) };
    await save();
    stage = 'recheck-current-destination';
    await verifyOldState(saved, false);
    if (await columnState() !== existed) throw failure('CLOUD_INGEST_COLUMN_CHANGED_SINCE_BACKUP');

    const user = `${config.prefix}.fp_ing_${randomBytes(4).toString('hex')}`;
    const password = `Fp!9aA${randomBytes(32).toString('base64url')}`;
    if (user.length > 32) throw failure('CLOUD_INGEST_ACCOUNT_INVALID');
    stage = 'reserve-writer-credentials';
    await fileStore.writeExclusive(privateEnvPath, writerEnvironment(config, user, password, connectTimeoutMs, queryTimeoutMs));
    report.privateEnvWritten = true; report.completedOperations.push('reserve-private-writer-environment'); await save();

    if (!existed) {
      stage = 'add-durable-eligibility-column';
      await mutate('add-durable-eligibility-column', addColumnSql);
    }
    stage = 'verify-additive-change-and-old-data';
    if (!await columnState()) throw failure('CLOUD_INGEST_ELIGIBILITY_COLUMN_MISSING');
    await verifyOldState(saved, !existed);
    if (!existed) {
      const [legacy] = await read('SELECT COUNT(*) AS nonzero FROM `fingerprint`.`biometric_svc_event_processing` WHERE `automatic_finalization_eligible` <> 0 OR `automatic_finalization_eligible` IS NULL');
      if (!Array.isArray(legacy) || legacy.length !== 1 || Number(legacy[0]?.nonzero) !== 0) {
        throw failure('CLOUD_INGEST_LEGACY_ELIGIBILITY_NOT_ZERO');
      }
      report.newLegacyEligibilityDefaultVerified = true;
    }
    report.oldRowsAndDdlVerified = true; report.existingEligibilityValuesPreserved = existed;
    report.eligibilityColumnAdded = !existed; await save();

    stage = 'create-new-ingest-writer';
    const account = `'${user}'@'%'`;
    await mutate('create-new-ingest-writer', `CREATE USER ${account} IDENTIFIED BY '${password}'`);
    stage = 'grant-exact-ingest-matrix';
    for (const [table, privileges] of Object.entries(INGEST_TABLE_PRIVILEGES)) {
      await mutate(`grant-ingest-writer:${table}`, `GRANT ${privileges.join(',')} ON \`fingerprint\`.${identifier(table)} TO ${account}`);
    }
    stage = 'verify-ingest-writer-with-runtime-guard';
    await verifyWriter({ host: config.host, port: config.port, user, password, database: target,
      confirmedName: target, sslMode: 'required', connectionLimit: 5, connectTimeoutMs, queryTimeoutMs, transactionTimeoutMs: 30000 });
    report.writerVerified = true; report.partialPreparationPossible = false; report.passed = true;
  } catch (error) {
    report.failure = { stage, code: safeCode(error) }; report.failedOperation = activeOperation;
    // Preserve the fresh backup, generated credentials, additive column and
    // operation journal. Never drop/revoke/overwrite resources after failure.
  } finally {
    report.cleanup.setupConnectionClosed = await closeConnection(connection, queryTimeoutMs);
    report.completedAtUtc = new Date().toISOString();
    try { await save(); } catch { report.passed = false; report.reportingFailed = true;
      report.failure ??= { stage: 'write-report', code: 'CLOUD_INGEST_REPORT_FAILED' }; }
  }
  return report;
}

async function verifyRuntimeWriter(config) {
  const database = await createIngestDatabase(config);
  try { await database.checkReady(); } finally { await database.end(); }
}
function configuration(env) {
  if (!env || Object.keys(env).some(key => key.startsWith('TIDB_SOURCE_') && env[key] !== undefined && String(env[key]).length)) throw failure('CLOUD_INGEST_SOURCE_CONFIG_REJECTED');
  const host = required(env, 'TIDB_SETUP_HOST'), user = required(env, 'TIDB_SETUP_USER');
  const prefix = /^([A-Za-z0-9]{1,16})\.root$/.exec(user)?.[1];
  const port = env.TIDB_SETUP_PORT ?? '4000', password = env.TIDB_SETUP_PASSWORD;
  if (required(env, 'TIDB_SETUP_DATABASE') !== target || !prefix || host.length > 253 || !/^[A-Za-z0-9.-]+$/.test(host) ||
      typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024 ||
      typeof port !== 'string' || !/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw failure('CLOUD_INGEST_INPUT_INVALID');
  return { host, user, prefix, password, port: Number(port) };
}
function validateMatrix() {
  const entries = Object.entries(INGEST_TABLE_PRIVILEGES);
  if (entries.length !== names.length || entries.some(([table, privileges]) => !names.includes(table) || !Array.isArray(privileges) ||
      !privileges.includes('SELECT') || new Set(privileges).size !== privileges.length || privileges.some(privilege => !['SELECT', 'INSERT', 'UPDATE'].includes(privilege)))) throw failure('CLOUD_INGEST_MATRIX_INVALID');
}
function setupPrivileges(rows, needsAlter) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) return false;
  let createUser = false, canAlter = false;
  const covered = new Set();
  for (const row of rows) {
    const values = row && typeof row === 'object' ? Object.values(row) : [];
    if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length > 32768) return false;
    const match = /^GRANT\s+(.+?)\s+ON\s+(\*\.\*|`?fingerprint`?\.(?:\*|`?[A-Za-z0-9_]+`?))\s+TO\s+.+?(\s+WITH\s+GRANT\s+OPTION)?$/i.exec(values[0].trim());
    if (!match) continue;
    const privileges = new Set(match[1].toUpperCase().split(/\s*,\s*/).map(value => value.trim().replace(/\s+/g, ' ')));
    const all = privileges.has('ALL PRIVILEGES'), scope = match[2].replaceAll('`', '');
    const targetTables = scope === '*.*' || scope === 'fingerprint.*' ? names : names.filter(name => scope === `fingerprint.${name}`);
    if (scope === '*.*' && (all || privileges.has('CREATE USER'))) createUser = true;
    if (targetTables.includes(processing) && (all || privileges.has('ALTER'))) canAlter = true;
    if (match[3]) for (const table of targetTables) for (const privilege of INGEST_TABLE_PRIVILEGES[table]) {
      if (all || privileges.has(privilege)) covered.add(`${table}:${privilege}`);
    }
  }
  return createUser && (!needsAlter || canAlter) && Object.entries(INGEST_TABLE_PRIVILEGES)
    .every(([table, privileges]) => privileges.every(privilege => covered.has(`${table}:${privilege}`)));
}
function validateManifest(manifest) {
  if (!manifest || manifest.format !== 'biometric-backup-v1' || manifest.purpose !== 'standalone-destination' ||
      manifest.schema !== target || manifest.consistentSnapshot !== true || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(manifest.snapshotAt ?? '') ||
      !Array.isArray(manifest.tables) || manifest.tables.length !== names.length || new Set(manifest.tables.map(table => table?.name)).size !== names.length) throw failure('CLOUD_INGEST_BACKUP_INVALID');
  for (const table of manifest.tables) {
    const key = table.name === processing ? 'ingest_event_id' : 'id';
    if (!names.includes(table.name) || table.rowsFile !== `${table.name}.rows.json` || table.primaryKey !== key ||
        !Array.isArray(table.columns) || !table.columns.length || new Set(table.columns).size !== table.columns.length ||
        table.columns.some(column => typeof column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) || !table.columns.includes(key) ||
        !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 || !/^[a-f0-9]{64}$/.test(table.rowsSha256 ?? '') ||
        (table.autoIncrement !== null && !/^[1-9][0-9]*$/.test(String(table.autoIncrement))) ||
        (table.maxKey !== null && !/^[0-9]+$/.test(String(table.maxKey)))) throw failure('CLOUD_INGEST_BACKUP_INVALID');
    try { validateTableDdl(table.ddl, table.name); } catch { throw failure('CLOUD_INGEST_BACKUP_INVALID'); }
  }
}
function writerEnvironment(config, user, password, connectTimeoutMs, queryTimeoutMs) {
  const values = { BIOMETRIC_INGEST_DB_HOST: config.host, BIOMETRIC_INGEST_DB_PORT: String(config.port), BIOMETRIC_INGEST_DB_USER: user,
    BIOMETRIC_INGEST_DB_PASSWORD: password, BIOMETRIC_INGEST_DB_NAME: target, BIOMETRIC_INGEST_DB_CONFIRMED_NAME: target,
    BIOMETRIC_INGEST_DB_SSL_MODE: 'required', BIOMETRIC_INGEST_DB_CONNECT_TIMEOUT_MS: String(connectTimeoutMs),
    BIOMETRIC_INGEST_DB_QUERY_TIMEOUT_MS: String(queryTimeoutMs) };
  return '# Private generated ingest database account. Never commit or share.\n' +
    Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
}
function backupFile(directory, name) {
  if (!names.some(table => name === `${table}.rows.json`)) throw failure('CLOUD_INGEST_BACKUP_PATH_REJECTED');
  return path.join(directory, name);
}
function removeEligibilityDefinition(ddl) {
  const open = ddl.indexOf('(');
  let index = open + 1, start = index, depth = 1, close = -1;
  const parts = [];
  while (index < ddl.length) {
    const stop = lexicalStop(ddl, index);
    if (stop > index) { index = stop; continue; }
    const character = ddl[index];
    if (character === '(') depth++;
    else if (character === ')') { depth--; if (!depth) { parts.push(ddl.slice(start, index)); close = index; break; } }
    else if (character === ',' && depth === 1) { parts.push(ddl.slice(start, index)); start = index + 1; }
    index++;
  }
  const matching = parts.filter(part => /^\s*`automatic_finalization_eligible`\s+/i.test(part));
  if (close < 0 || matching.length !== 1) throw failure('CLOUD_INGEST_EXISTING_DDL_CHANGED');
  return ddl.slice(0, open + 1) + parts.filter(part => part !== matching[0]).join(',') + ddl.slice(close);
}
function ddlState(ddl) {
  let output = '', depth = 0, outerClosed = false, autoIncrement = null;
  for (let index = 0; index < ddl.length;) {
    const stop = lexicalStop(ddl, index);
    if (stop > index) { output += ddl.slice(index, stop); index = stop; continue; }
    const character = ddl[index];
    if (/\s/.test(character)) { if (!output.endsWith(' ')) output += ' '; index++; continue; }
    if (character === '(') depth++;
    else if (character === ')' && --depth === 0) outerClosed = true;
    if (outerClosed && depth === 0 && !/[A-Za-z0-9_]/.test(ddl[index - 1] ?? '')) {
      const counter = /^AUTO_INCREMENT\s*=\s*([0-9]+)\b/i.exec(ddl.slice(index));
      if (counter) {
        if (autoIncrement !== null) throw failure('CLOUD_INGEST_EXISTING_DDL_CHANGED');
        autoIncrement = counter[1]; output += 'AUTO_INCREMENT=<counter>'; index += counter[0].length; continue;
      }
    }
    output += character; index++;
  }
  return { normalized: output.trim(), autoIncrement };
}
function isCounter(value, allowZero) {
  return ((typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) && (allowZero || BigInt(value) > 0n);
}
function lexicalStop(sql, index) {
  if (sql.startsWith('/*', index)) { const end = sql.indexOf('*/', index + 2); if (end < 0) throw failure('CLOUD_INGEST_DDL_INVALID'); return end + 2; }
  if (sql[index] === '#' || (sql.startsWith('--', index) && /\s/.test(sql[index + 2] ?? ''))) { const end = sql.indexOf('\n', index); return end < 0 ? sql.length : end + 1; }
  const quote = sql[index];
  if (!['`', "'", '"'].includes(quote)) return index;
  let at = index + 1;
  while (at < sql.length) {
    if (sql[at] === '\\' && quote !== '`') { at += 2; continue; }
    if (sql[at++] === quote) { if (sql[at] === quote) { at++; continue; } return at; }
  }
  throw failure('CLOUD_INGEST_DDL_INVALID');
}
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw failure('CLOUD_INGEST_IDENTIFIER_INVALID'); return `\`${value}\``; }
function sha(text) { return createHash('sha256').update(text).digest('hex'); }
function required(env, key) { if (typeof env?.[key] !== 'string' || !env[key].trim()) throw failure('CLOUD_INGEST_INPUT_INVALID'); return env[key].trim(); }
function failure(code) { return Object.assign(new Error('The destination ingest database could not be prepared'), { code }); }
function safeCode(error) { return /^(?:CLOUD_INGEST_[A-Z0-9_]+|INGEST_DATABASE_[A-Z0-9_]+|BIOMETRIC_BACKUP_EXPORT_[A-Z0-9_]+|ER_[A-Z0-9_]+|E[A-Z0-9_]{1,40})$/.test(error?.code ?? '') ? error.code : 'CLOUD_INGEST_PREPARATION_FAILED'; }
function bounded(promise, milliseconds, onTimeout, code) { return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { try { onTimeout(); } catch {} reject(failure(code)); }, milliseconds);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
}); }
async function closeConnection(connection, milliseconds) { if (!connection) return true; try { await bounded(Promise.resolve().then(() => connection.end()), Math.min(milliseconds, 2000), () => connection.destroy(), 'CLOUD_INGEST_CLOSE_TIMEOUT'); return true; } catch { try { connection.destroy(); } catch {} return false; } }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--plan', '--apply'].includes(args[0]))) { console.error('CLOUD_INGEST_ARGUMENTS_INVALID'); process.exitCode = 1; }
  else { const report = await prepareCloudIngestDatabase({ apply: args[0] === '--apply' }); console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1; }
}
