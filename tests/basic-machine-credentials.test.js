import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBasicMachineCredentials } from '../src/infrastructure/ingest/basic-machine-credentials.js';

test('machine Basic credentials are optional and normalize to an immutable credentials-only copy', () => {
  assert.equal(normalizeBasicMachineCredentials(), null);
  assert.equal(normalizeBasicMachineCredentials(null), null);
  assert.equal(normalizeBasicMachineCredentials(undefined), null);
  const input = { username: 'device-1', password: 'a'.repeat(32), portalRole: 'admin', extraSecret: 'UNRELATED_PRIVATE_VALUE' };
  const normalized = normalizeBasicMachineCredentials(input);
  assert.deepEqual(normalized, { username: 'device-1', password: 'a'.repeat(32) });
  assert.equal(Object.isFrozen(normalized), true);
  assert.notEqual(normalized, input);
  input.username = 'changed'; input.password = 'b'.repeat(32);
  assert.equal(normalized.username, 'device-1');
  assert.equal(normalized.password, 'a'.repeat(32));
  assert.equal(JSON.stringify(normalized).includes('UNRELATED_PRIVATE_VALUE'), false);
  assert.throws(() => { normalized.password = 'changed'; }, TypeError);
});

test('machine Basic configuration requires both exact ASCII fields and strong URL-safe credential length', () => {
  const valid = { username: 'd', password: 'a'.repeat(32) };
  for (const input of [false, 0, '', 'private-value', [], {}, { username: 'device' }, { password: valid.password },
    { username: undefined, password: undefined }, Object.create(valid),
    ...['', '-device', '.device', '_device', ' device', 'device ', 'a'.repeat(33), 'd:other', 'dévice', 'd\n'].map(username => ({ ...valid, username })),
    ...['p', 'a'.repeat(31), 'a'.repeat(129), 'a'.repeat(31) + ':', 'a'.repeat(31) + '/',
      'a'.repeat(31) + '+', 'a'.repeat(31) + '=', 'a'.repeat(31) + '.', 'a'.repeat(31) + '~',
      'a'.repeat(31) + ' ', 'a'.repeat(31) + '\n', 'a'.repeat(31) + 'é'].map(password => ({ ...valid, password }))]) {
    assert.throws(() => normalizeBasicMachineCredentials(input), { code: 'INGEST_AUTH_CONFIG_INVALID' });
  }
  assert.deepEqual(normalizeBasicMachineCredentials({ username: 'D9._-' + 'x'.repeat(27), password: 'Z9_-'.repeat(32) }),
    { username: 'D9._-' + 'x'.repeat(27), password: 'Z9_-'.repeat(32) });
});

test('invalid Basic configuration never exposes throwing getters or proxy errors', () => {
  const privateMessage = 'SYNTHETIC_PRIVATE_CONFIGURATION_ERROR';
  const getter = { username: 'device', get password() { throw new Error(privateMessage); } };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const input of [getter, revoked.proxy]) {
    assert.throws(() => normalizeBasicMachineCredentials(input), error => {
      assert.equal(error.code, 'INGEST_AUTH_CONFIG_INVALID');
      assert.equal(error.cause, undefined);
      assert.equal(String(error.stack).includes(privateMessage), false);
      return true;
    });
  }
});
