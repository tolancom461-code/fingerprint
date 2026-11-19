const TABLE_NAME = 'biometric_svc_program_connections';
const TABLE = '`biometric_svc_program_connections`';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC = `id, program_name, token_prefix, status, created_by, revoked_by,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at_utc,
  DATE_FORMAT(revoked_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS revoked_at_utc`;
const COLUMNS = {
  id: ['char', 36, false, 'ascii_bin'], program_name: ['varchar', 100, false, 'utf8mb4_bin'],
  token_hash: ['char', 64, false, 'ascii_bin'], token_prefix: ['varchar', 12, false, 'ascii_bin'],
  status: ['varchar', 16, false, 'ascii_bin'], created_by: ['varchar', 128, false, 'utf8mb4_bin'],
  created_at: ['datetime', 6, false, null], revoked_at: ['datetime', 6, true, null],
  revoked_by: ['varchar', 128, true, 'utf8mb4_bin'],
};

/** Explicit guarded pool only. Never opens a database or applies DDL. */
export class TiDbProgramConnectionsStore {
  constructor(pool) {
    if (!pool || typeof pool.execute !== 'function') throw safe('PROGRAM_CONNECTIONS_UNAVAILABLE');
    this.pool = pool;
    this.readiness = null;
  }

  async assertReady() {
    if (!this.readiness) this.readiness = this.verifySchema().catch(error => { this.readiness = null; throw storageFailure(error); });
    await this.readiness;
    return { ready: true };
  }

  async verifySchema() {
    const [tables] = await this.pool.execute(
      `SELECT ENGINE, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [TABLE_NAME]);
    if (tables.length !== 1 || String(tables[0].ENGINE).toLowerCase() !== 'innodb' || tables[0].TABLE_TYPE !== 'BASE TABLE') throw schema();
    const [columns] = await this.pool.execute(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, DATETIME_PRECISION, IS_NULLABLE, COLLATION_NAME, COLUMN_DEFAULT, EXTRA
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [TABLE_NAME]);
    if (columns.length !== Object.keys(COLUMNS).length) throw schema();
    for (const [name, [type, size, nullable, collation]] of Object.entries(COLUMNS)) {
      const column = columns.find(row => row.COLUMN_NAME === name);
      if (!column || column.DATA_TYPE !== type || Number(type === 'datetime' ? column.DATETIME_PRECISION : column.CHARACTER_MAXIMUM_LENGTH) !== size ||
          column.IS_NULLABLE !== (nullable ? 'YES' : 'NO') || column.COLLATION_NAME !== collation ||
          (nullable && column.COLUMN_DEFAULT !== null) ||
          (column.EXTRA !== '' && !(name === 'created_at' && String(column.EXTRA).toLowerCase() === 'default_generated'))) throw schema();
    }
    const [indexes] = await this.pool.execute(
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [TABLE_NAME]);
    const expected = { PRIMARY: [0, ['id']], uq_biometric_svc_program_token_hash: [0, ['token_hash']],
      idx_biometric_svc_program_status_created: [1, ['status', 'created_at', 'id']] };
    if (indexes.some(row => !Object.hasOwn(expected, row.INDEX_NAME))) throw schema();
    for (const [name, [nonUnique, fields]] of Object.entries(expected)) {
      const rows = indexes.filter(row => row.INDEX_NAME === name);
      if (rows.length !== fields.length || rows.some((row, index) => row.COLUMN_NAME !== fields[index] ||
          Number(row.NON_UNIQUE) !== nonUnique || Number(row.SEQ_IN_INDEX) !== index + 1 || row.SUB_PART !== null)) throw schema();
    }
  }

  async list() {
    return this.run(async () => {
      const [rows] = await this.pool.execute(`SELECT ${PUBLIC} FROM ${TABLE} ORDER BY created_at DESC, id DESC LIMIT 200`);
      return rows.map(decode);
    });
  }

  async create({ id, programName, tokenHash, tokenPrefix, actor }) {
    identifier(id); bounded(programName, 100); bounded(actor, 128);
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !/^[A-Za-z0-9_-]{12}$/.test(tokenPrefix)) throw invalid();
    return this.run(async () => {
      await this.pool.execute(`INSERT INTO ${TABLE} (id, program_name, token_hash, token_prefix, status, created_by, created_at, revoked_at, revoked_by)
        VALUES (?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(6), NULL, NULL)`, [id, programName, tokenHash, tokenPrefix, actor]);
      return this.find(id);
    });
  }

  async revoke({ id, actor }) {
    identifier(id); bounded(actor, 128);
    return this.run(async () => {
      // A single conditional UPDATE preserves the first revoker and timestamp on retries.
      await this.pool.execute(`UPDATE ${TABLE} SET status = 'revoked', revoked_at = UTC_TIMESTAMP(6), revoked_by = ?
        WHERE id = ? AND status = 'active'`, [actor, id]);
      return this.find(id);
    });
  }

  async findActiveByTokenHash(tokenHash) {
    if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) throw invalid();
    return this.run(async () => {
      const [rows] = await this.pool.execute(`SELECT ${PUBLIC} FROM ${TABLE} WHERE token_hash = ? AND status = 'active' LIMIT 1`, [tokenHash]);
      return rows[0] ? decode(rows[0]) : null;
    });
  }

  async find(id) {
    const [rows] = await this.pool.execute(`SELECT ${PUBLIC} FROM ${TABLE} WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ? decode(rows[0]) : null;
  }

  async run(operation) {
    try { await this.assertReady(); return await operation(); }
    catch (error) { throw storageFailure(error); }
  }
}

function decode(row) {
  return { id: row.id, programName: row.program_name, tokenPrefix: row.token_prefix, status: row.status,
    createdBy: row.created_by, createdAtUtc: row.created_at_utc, revokedAtUtc: row.revoked_at_utc ?? null, revokedBy: row.revoked_by ?? null };
}
function identifier(value) { if (typeof value !== 'string' || !UUID.test(value)) throw invalid(); }
function bounded(value, max) {
  if (typeof value !== 'string' || !value.length || [...value].length > max || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value) || /\p{Surrogate}/u.test(value)) throw invalid();
}
function invalid() { return safe('PROGRAM_CONNECTION_INVALID_INPUT'); }
function schema() { return safe('PROGRAM_CONNECTIONS_SCHEMA_NOT_READY'); }
function safe(code) { return Object.assign(new Error(code), { code }); }
function storageFailure(error) {
  if (error?.code === 'PROGRAM_CONNECTIONS_SCHEMA_NOT_READY') return schema();
  if (error?.code === 'ER_NO_SUCH_TABLE' || error?.code === 'ER_BAD_FIELD_ERROR') return schema();
  return safe(error?.code === 'ER_DUP_ENTRY' ? 'PROGRAM_CONNECTION_CONFLICT' : 'PROGRAM_CONNECTIONS_UNAVAILABLE');
}
