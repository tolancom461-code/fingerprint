import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoPortalService } from '../src/application/demo-portal-service.js';

test('demo overview reports synthetic records and no connected devices or delivery', () => {
  const service = createDemoPortalService();
  assert.deepEqual(service.overview(), {
    mode: 'demo', counts: { devices: 2, people: 3, events: 6 },
    deviceConnection: 'not_connected', outboundDelivery: 'disabled',
  });
  for (const device of service.listDevices().items) {
    assert.match(device.id, /^demo-device-/);
    assert.match(device.serialNumber, /^DEMO-DEVICE-/);
    assert.equal(device.status, 'not_connected');
    assert.equal(device.lastSeenAt, null);
    assert.deepEqual(Object.keys(device).sort(), ['id', 'name', 'serialNumber', 'model', 'status', 'lastSeenAt'].sort());
  }
});

test('sample event data has fixed historical dates and only demo identities', () => {
  const service = createDemoPortalService();
  const people = service.listPeople().items;
  for (const person of people) {
    assert.match(person.id, /^demo-person-/);
    assert.match(person.personCode, /^DEMO-00[1-3]$/);
    assert.match(person.displayName, /تجريبي/);
    assert.deepEqual(Object.keys(person).sort(), ['id', 'personCode', 'displayName', 'status'].sort());
  }
  for (const event of service.listEvents().items) {
    assert.match(event.id, /^demo-event-/);
    assert.match(event.personCode, /^DEMO-00[1-3]$/);
    assert.match(event.personName, /تجريبي/);
    assert.ok(['check_in', 'check_out'].includes(event.eventType));
    assert.equal(new Date(event.eventTimeUtc).toISOString().slice(0, 10), '2026-01-15');
    assert.equal(event.verificationMethod, 'demo');
    assert.deepEqual(Object.keys(event).sort(), ['id', 'personCode', 'personName', 'eventType', 'eventTimeUtc', 'verificationMethod', 'deviceName'].sort());
  }
  const data = JSON.stringify({ people, events: service.listEvents().items, devices: service.listDevices().items });
  for (const forbidden of ['template', 'biometricData', 'password', 'workerId', 'AJE1261900133']) {
    assert.equal(data.includes(forbidden), false);
  }
});

test('lists search appropriate fields case-insensitively and paginate filtered rows', () => {
  const service = createDemoPortalService();
  assert.equal(service.listDevices({ search: 'demo-device-002' }).items[0].id, 'demo-device-002');
  assert.equal(service.listPeople({ search: ' تجريبي 2 ' }).items[0].personCode, 'DEMO-002');
  const events = service.listEvents({ search: 'demo-001', page: '2', limit: '1' });
  assert.equal(events.items.length, 1);
  assert.equal(events.items[0].eventType, 'check_out');
  assert.deepEqual(events.page, { number: 2, limit: 1, total: 2, totalPages: 2 });
  assert.equal(service.listEvents({ search: 'check_in' }).page.total, 3);
  assert.deepEqual(service.listPeople({ page: 2, limit: 2 }).items.map(person => person.personCode), ['DEMO-003']);
  assert.deepEqual(service.listPeople({ page: 10 }).items, []);
  assert.deepEqual(service.listEvents({ search: 'no such demo' }).page, { number: 1, limit: 20, total: 0, totalPages: 1 });
});

test('list inputs reject partial, out-of-range and nonnumeric pagination', () => {
  const service = createDemoPortalService();
  for (const name of ['listDevices', 'listPeople', 'listEvents']) {
    for (const value of ['1tail', '1.5', '1e2', '0x10', ' 1', '1 ', '', null, true, {}, [], 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => service[name]({ page: value }), error => error instanceof TypeError && error.status === 400 && error.code === 'INVALID_INPUT');
      assert.throws(() => service[name]({ limit: value }), error => error.status === 400);
    }
    assert.throws(() => service[name]({ limit: 101 }), { status: 400 });
    assert.throws(() => service[name]({ search: 'x'.repeat(121) }), { status: 400 });
    assert.throws(() => service[name]({ search: 1 }), { status: 400 });
    assert.throws(() => service[name](null), { status: 400 });
    assert.equal(service[name]({ page: Number.MAX_SAFE_INTEGER }).items.length, 0);
    assert.equal(service[name]({ limit: '100' }).page.limit, 100);
  }
});

test('createPerson validates demo-only codes and names and rejects duplicates after normalization', () => {
  const service = createDemoPortalService();
  const person = service.createPerson({ personCode: ' demo-new_1.test ', displayName: '  اسم تجريبي  ' });
  assert.deepEqual(person, { id: 'demo-person-004', personCode: 'DEMO-NEW_1.TEST', displayName: 'اسم تجريبي', status: 'active' });
  assert.equal(service.listPeople({ search: 'DEMO-NEW_1.TEST' }).page.total, 1);
  assert.equal(service.overview().counts.people, 4);
  assert.equal(service.overview().counts.events, 6);
  assert.throws(() => service.createPerson({ personCode: 'demo-new_1.TEST', displayName: 'آخر' }), { code: 'PERSON_CODE_CONFLICT', status: 409 });
  assert.throws(() => service.createPerson({ personCode: 'demo-001', displayName: 'آخر' }), { status: 409 });
  for (const personCode of ['900001', 'DEMO-', 'DEMO-عربي', 'DEMO-NEW CODE', 'DEMO-<X>', 'DEMO-' + 'A'.repeat(61), '', 123, null]) {
    assert.throws(() => service.createPerson({ personCode, displayName: 'اسم' }), { status: 400 });
  }
  for (const displayName of ['', '   ', 'x'.repeat(121), undefined, 123, null]) {
    assert.throws(() => service.createPerson({ personCode: 'DEMO-VALID', displayName }), { status: 400 });
  }
  assert.throws(() => service.createPerson(null), { status: 400 });
  assert.throws(() => service.createPerson([]), { status: 400 });
  assert.equal(service.overview().counts.people, 4);
});

test('factory instances and returned rows cannot mutate each other or internal data', () => {
  const first = createDemoPortalService();
  const second = createDemoPortalService();
  const created = first.createPerson({ personCode: 'DEMO-EXTRA', displayName: 'إضافي' });
  created.personCode = 'CORRUPTED';
  first.listPeople().items[0].displayName = 'CORRUPTED';
  first.listDevices().items[0].status = 'connected';
  first.listEvents().items[0].personCode = 'CORRUPTED';
  first.overview().counts.devices = 100;
  assert.equal(first.listPeople({ search: 'DEMO-EXTRA' }).page.total, 1);
  assert.equal(first.listPeople().items[0].displayName, 'شخص تجريبي 1');
  assert.equal(first.listDevices().items[0].status, 'not_connected');
  assert.equal(first.listEvents().items[0].personCode, 'DEMO-001');
  assert.equal(first.overview().counts.devices, 2);
  assert.equal(second.overview().counts.people, 3);
  assert.equal(second.listPeople({ search: 'DEMO-EXTRA' }).page.total, 0);
  assert.equal(createDemoPortalService().overview().counts.people, 3);
});

test('demo capacity is bounded and rejection preserves existing data', () => {
  const service = createDemoPortalService();
  for (let index = 0; index < 997; index++) {
    service.createPerson({ personCode: `DEMO-EXTRA-${index}`, displayName: `شخص إضافي ${index}` });
  }
  assert.equal(service.overview().counts.people, 1000);
  assert.equal(service.listPeople({ page: 10, limit: 100 }).items.length, 100);
  assert.throws(() => service.createPerson({ personCode: 'DEMO-OVER-LIMIT', displayName: 'إضافي' }), { code: 'DEMO_CAPACITY_REACHED', status: 429 });
  assert.throws(() => service.createPerson({ personCode: 'DEMO-001', displayName: 'مكرر' }), { status: 409 });
  assert.equal(service.overview().counts.people, 1000);
  assert.equal(service.listPeople({ search: 'DEMO-OVER-LIMIT' }).page.total, 0);
});
