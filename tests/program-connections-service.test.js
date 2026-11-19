import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProgramConnectionsService } from '../src/application/program-connections-service.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const SECOND_ID = '123e4567-e89b-42d3-a456-426614174001';
function fixture() {
  const rows = new Map();
  const calls = [];
  let authReads = 0;
  const store = {
    async assertReady() { calls.push(['ready']); return { ready: true }; },
    async list() { return [...rows.values()]; },
    async create(input) {
      calls.push(['create', input]);
      const row = { id: input.id, programName: input.programName, tokenPrefix: input.tokenPrefix,
        tokenHash: input.tokenHash, status: 'active', createdBy: input.actor,
        createdAtUtc: '2026-11-19T10:00:00.123456Z', revokedAtUtc: null, revokedBy: null };
      rows.set(row.id, row);
      return row;
    },
    async revoke({ id, actor }) {
      const row = rows.get(id);
      if (!row) return null;
      if (row.status === 'active') Object.assign(row, { status: 'revoked', revokedBy: actor,
        revokedAtUtc: '2026-11-19T10:01:00.123456Z' });
      return row;
    },
    async findActiveByTokenHash(hash) { authReads++; return [...rows.values()].find(row => row.status === 'active' && row.tokenHash === hash) ?? null; },
  };
  let generation = 0;
  const service = new ProgramConnectionsService({ store, randomBytes: () => Buffer.alloc(32, ++generation),
    uuidFactory: () => generation === 0 ? ID : SECOND_ID });
  return { service, store, calls, rows, authReads: () => authReads };
}

test('creation returns a random-sized token once and persists only its digest and public prefix', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(calls, []);
  const created = await service.create({ programName: '  برنامج اليومية  ', actor: 'admin' });
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.connection.programName, 'برنامج اليومية');
  const persisted = calls.find(([action]) => action === 'create')[1];
  assert.equal(persisted.tokenHash, createHash('sha256').update(created.token).digest('hex'));
  assert.equal(persisted.tokenPrefix, created.token.slice(0, 12));
  assert.equal(JSON.stringify(calls).includes(created.token), false);
  const listed = await service.list();
  assert.equal(listed.items.length, 1);
  for (const value of [created.connection, listed.items[0]]) {
    assert.equal('token' in value, false);
    assert.equal('tokenHash' in value, false);
    assert.equal(JSON.stringify(value).includes(created.token), false);
  }
});

test('each program authenticates independently; revocation is immediate and repeat revocation preserves audit fields', async () => {
  const { service, authReads } = fixture();
  const first = await service.create({ programName: 'First program', actor: 'admin' });
  const second = await service.create({ programName: 'Second program', actor: 'admin' });
  assert.equal((await service.authenticate(first.token)).scope, 'punches:read');
  assert.equal((await service.authenticate(first.token)).id, first.connection.id);
  const revoked = await service.revoke({ id: first.connection.id, actor: 'operator-1' });
  assert.equal(revoked.connection.revokedBy, 'operator-1');
  assert.equal(await service.authenticate(first.token), null);
  assert.equal((await service.authenticate(second.token)).id, second.connection.id);
  assert.deepEqual(await service.revoke({ id: first.connection.id, actor: 'operator-2' }), revoked);
  assert.equal(authReads(), 4);
});

test('malformed keys never reach storage; valid-looking unknown keys fail without a principal', async () => {
  const { service, authReads } = fixture();
  for (const token of [null, undefined, [], {}, '', 'Bearer ' + 'a'.repeat(43), 'a'.repeat(42), 'a'.repeat(129), 'a'.repeat(42) + '!']) {
    assert.equal(await service.authenticate(token), null);
  }
  assert.equal(authReads(), 0);
  assert.equal(await service.authenticate('a'.repeat(43)), null);
  assert.equal(authReads(), 1);
});

test('bounded input rejects extra, accessor, malformed identifier and control data without evaluating getters', async () => {
  const { service, calls } = fixture();
  let getterReads = 0;
  const hostile = { get programName() { getterReads++; throw new Error('SYNTHETIC-SECRET'); }, actor: 'admin' };
  for (const value of [hostile, { programName: '', actor: 'admin' }, { programName: 'x'.repeat(101), actor: 'admin' },
    { programName: 'program\u0000name', actor: 'admin' }, { programName: 'name', actor: '' },
    { programName: 'name', actor: 'admin', token: 'SYNTHETIC-SECRET' }]) {
    await assert.rejects(() => service.create(value), error => error.code === 'PROGRAM_CONNECTION_INVALID_INPUT');
  }
  await assert.rejects(() => service.revoke({ id: 'not-a-uuid', actor: 'admin' }), error => error.code === 'PROGRAM_CONNECTION_INVALID_INPUT');
  assert.equal(getterReads, 0);
  assert.deepEqual(calls, []);
  await assert.rejects(() => service.revoke({ id: ID, actor: 'admin' }), error => error.code === 'PROGRAM_CONNECTION_NOT_FOUND');
});

test('raw storage/credential errors are replaced by fixed error codes', async () => {
  const { service, store } = fixture();
  for (const method of ['list', 'findActiveByTokenHash', 'create', 'revoke', 'assertReady']) {
    store[method] = async () => { throw new Error('SYNTHETIC-SQL-AND-SECRET'); };
  }
  const operations = [() => service.list(), () => service.authenticate('a'.repeat(43)),
    () => service.create({ programName: 'Test', actor: 'admin' }), () => service.revoke({ id: ID, actor: 'admin' }), () => service.assertReady()];
  for (const operation of operations) await assert.rejects(operation, error =>
    error.code === 'PROGRAM_CONNECTIONS_UNAVAILABLE' && error.message === 'PROGRAM_CONNECTIONS_UNAVAILABLE' && !String(error.stack).includes('SYNTHETIC'));
});

test('issuance entropy and identifier failures expose no raw error or partially generated key', async () => {
  const { store, calls } = fixture();
  for (const options of [
    { uuidFactory() { throw new Error('SYNTHETIC-ID-SECRET'); } },
    { uuidFactory: () => ID, randomBytes() { throw new Error('SYNTHETIC-RANDOM-SECRET'); } },
    { uuidFactory: () => ID, randomBytes: () => Buffer.alloc(1) },
  ]) {
    const service = new ProgramConnectionsService({ store, ...options });
    await assert.rejects(() => service.create({ programName: 'Program', actor: 'admin' }), error =>
      error.code === 'PROGRAM_CONNECTIONS_UNAVAILABLE' && !String(error.stack).includes('SYNTHETIC'));
  }
  assert.deepEqual(calls, []);
});
