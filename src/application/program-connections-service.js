import { createHash, randomBytes as secureRandomBytes, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_FIELDS = ['id', 'programName', 'tokenPrefix', 'status', 'createdBy', 'createdAtUtc', 'revokedAtUtc', 'revokedBy'];

/** Durable per-program read credentials. Only create() ever returns a plaintext token. */
export class ProgramConnectionsService {
  constructor({ store, randomBytes = secureRandomBytes, uuidFactory = randomUUID }) {
    if (!store || typeof randomBytes !== 'function' || typeof uuidFactory !== 'function') throw failure('PROGRAM_CONNECTIONS_UNAVAILABLE', 503);
    this.store = store;
    this.randomBytes = randomBytes;
    this.uuidFactory = uuidFactory;
  }

  async assertReady() { return run(() => this.store.assertReady()); }

  async list() {
    const rows = await run(() => this.store.list());
    if (!Array.isArray(rows) || rows.length > 200) throw failure('PROGRAM_CONNECTIONS_UNAVAILABLE', 503);
    return { items: rows.map(publicConnection) };
  }

  async create(value) {
    const input = snapshot(value, ['programName', 'actor']);
    const programName = text(input.programName, 100);
    const actor = text(input.actor, 128);
    let id;
    let bytes;
    try { id = identifier(this.uuidFactory()); bytes = this.randomBytes(32); }
    catch { throw failure('PROGRAM_CONNECTIONS_UNAVAILABLE', 503); }
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw failure('PROGRAM_CONNECTIONS_UNAVAILABLE', 503);
    const token = bytes.toString('base64url');
    const connection = await run(() => this.store.create({ id, programName, actor,
      tokenHash: digest(token), tokenPrefix: token.slice(0, 12) }));
    return { connection: publicConnection(connection), token };
  }

  async revoke(value) {
    const input = snapshot(value, ['id', 'actor']);
    const id = identifier(input.id);
    const actor = text(input.actor, 128);
    const connection = await run(() => this.store.revoke({ id, actor }));
    if (!connection) throw failure('PROGRAM_CONNECTION_NOT_FOUND', 404);
    return { connection: publicConnection(connection) };
  }

  async authenticate(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    // No authentication cache: revocation is checked on every request.
    const connection = await run(() => this.store.findActiveByTokenHash(digest(token)));
    return connection && connection.status === 'active'
      ? { id: connection.id, programName: connection.programName, scope: 'punches:read' } : null;
  }
}

function digest(token) { return createHash('sha256').update(token, 'utf8').digest('hex'); }
function publicConnection(row) {
  if (!row || typeof row !== 'object') throw failure('PROGRAM_CONNECTIONS_UNAVAILABLE', 503);
  return Object.fromEntries(PUBLIC_FIELDS.map(key => [key, row[key] ?? null]));
}
function snapshot(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !keys.includes(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
      result[key] = descriptor.value;
    }
    return result;
  } catch { throw invalid(); }
}
function text(value, max) {
  if (typeof value !== 'string') throw invalid();
  const clean = value.trim();
  if (!clean || [...clean].length > max || /[\u0000-\u001f\u007f]/.test(clean) || /\p{Surrogate}/u.test(clean)) throw invalid();
  return clean;
}
function identifier(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}
function invalid() { return failure('PROGRAM_CONNECTION_INVALID_INPUT', 400); }
function failure(code, status) { return Object.assign(new Error(code), { code, status }); }
async function run(operation) {
  try { return await operation(); }
  catch (error) {
    const codes = new Map([['PROGRAM_CONNECTIONS_SCHEMA_NOT_READY', 503], ['PROGRAM_CONNECTION_CONFLICT', 409]]);
    const status = codes.get(error?.code);
    throw failure(status ? error.code : 'PROGRAM_CONNECTIONS_UNAVAILABLE', status ?? 503);
  }
}
