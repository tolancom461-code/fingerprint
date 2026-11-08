import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvDeviceRegistry } from '../src/infrastructure/storage/env-device-registry.js';

test('registry supports multiple devices from the same vendor', () => {
  const registry = new EnvDeviceRegistry(['zkteco:A', 'zkteco:B']);
  assert.equal(registry.count(), 2);
  assert.equal(registry.isAllowed({ vendor: 'zkteco', serialNumber: 'A' }), true);
  assert.equal(registry.isAllowed({ vendor: 'zkteco', serialNumber: 'B' }), true);
});

test('device identity is vendor qualified', () => {
  const registry = new EnvDeviceRegistry(['zkteco:SAME', 'futurevendor:SAME']);
  assert.equal(registry.isAllowed({ vendor: 'zkteco', serialNumber: 'SAME' }), true);
  assert.equal(registry.isAllowed({ vendor: 'futurevendor', serialNumber: 'SAME' }), true);
  assert.equal(registry.isAllowed({ vendor: 'unknown', serialNumber: 'SAME' }), false);
});

test('unqualified device entries are rejected', () => {
  assert.throws(() => new EnvDeviceRegistry(['SERIAL_ONLY']), /vendor:serialNumber/);
});
