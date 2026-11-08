import test from 'node:test';
import assert from 'node:assert/strict';
import { VendorAdapterRegistry } from '../src/infrastructure/vendors/vendor-adapter-registry.js';

function adapter(vendor, pathname) {
  return {
    vendor,
    matches(req) {
      return new URL(req.url, 'http://local').pathname.startsWith(pathname);
    },
    async handle() {}
  };
}

test('vendor adapter registry dispatches without putting vendor logic in the core', () => {
  const registry = new VendorAdapterRegistry([
    adapter('zkteco', '/iclock/'),
    adapter('futurevendor', '/future/')
  ]);

  assert.equal(registry.match({ url: '/iclock/cdata' }).vendor, 'zkteco');
  assert.equal(registry.match({ url: '/future/events' }).vendor, 'futurevendor');
  assert.equal(registry.match({ url: '/unknown' }), null);
});

test('duplicate vendor adapters are rejected', () => {
  assert.throws(
    () => new VendorAdapterRegistry([adapter('zkteco', '/a'), adapter('zkteco', '/b')]),
    /Duplicate biometric vendor adapter/
  );
});
