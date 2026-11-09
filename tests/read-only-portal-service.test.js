import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadOnlyPortalService } from '../src/application/read-only-portal-service.js';
import { TiDbAdminReadStore } from '../src/infrastructure/storage/tidb-admin-read-store.js';

const UUID = '11111111-2222-4333-8444-555555555555';

function device(overrides = {}) {
  return { id: '9007199254740993', display_name: 'جهاز الاختبار', serial_number: 'TEST-001', model: 'SpeedFace',
    status: 'active', last_seen_at: '2026-11-09 10:20:30.123456', ...overrides };
}

function person(overrides = {}) {
  return { id: '9007199254740995', person_code: '123', display_name: 'اسم الاختبار', status: 'active', ...overrides };
}

function event(overrides = {}) {
  return { id: '9007199254740997', final_event_uuid: UUID, person_code: '123', person_name: 'اسم الاختبار',
    event_type: 'check_in', event_time_utc: '2026-11-09 07:20:30.123456', verification_method: 'fingerprint',
    device_display_name: 'جهاز الاختبار', ...overrides };
}

function page(items, query = { page: 1, limit: 20 }, total = items.length) {
  return { items, page: { number: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) } };
}

function fixture(overrides = {}) {
  const calls = [];
  const store = {
    async getDashboard() { calls.push(['dashboard']); return { devices: { total: 350 }, people: { total: 700 }, finalEvents: { total: 900 } }; },
    async pageDevices(query) { calls.push(['devices', query]); return page([device()], query); },
    async pagePeople(query) { calls.push(['people', query]); return page([person()], query); },
    async pageFinalEvents(query) { calls.push(['events', query]); return page([event()], query); },
    ...overrides,
  };
  return { calls, store, service: createReadOnlyPortalService({ readStore: store }) };
}

const invalidInput = error => error instanceof TypeError && error.code === 'INVALID_INPUT' && error.status === 400;
const invalidSource = error => error instanceof TypeError && error.code === 'READ_MODEL_INVALID' && error.status === 500;

test('construction requires the existing read contract and exposes only four read operations', () => {
  for (const value of [undefined, {}, { readStore: {} }, { readStore: { getDashboard() {} } }]) {
    assert.throws(() => createReadOnlyPortalService(value), TypeError);
  }
  const { service } = fixture();
  assert.deepEqual(Object.keys(service).sort(), ['overview', 'listDevices', 'listPeople', 'listEvents'].sort());
  assert.equal(service.createPerson, undefined);
  assert.ok(Object.isFrozen(service));
});

test('overview uses dashboard totals without sampling lists or claiming device or delivery connectivity', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.overview(), {
    mode: 'database-readonly', counts: { devices: 350, people: 700, events: 900 },
    deviceConnection: 'unknown', outboundDelivery: 'unknown',
  });
  assert.deepEqual(calls, [['dashboard']]);
});

test('device projection preserves large IDs and distinguishes administrative activation from connection state', async () => {
  const original = device({ last_ip_address: '192.0.2.1', safe_capabilities: { secret: true }, notes: 'private',
    password: 'private', worker_id: 9, status: 'active' });
  const { service } = fixture({ async pageDevices(query) { return { ...page([original], query), secret: true }; } });
  const result = await service.listDevices();
  assert.deepEqual(result, {
    items: [{ id: '9007199254740993', name: 'جهاز الاختبار', serialNumber: 'TEST-001', model: 'SpeedFace',
      status: 'unknown', administrativeStatus: 'active', lastSeenAt: '2026-11-09T10:20:30.123456Z' }],
    page: { number: 1, limit: 20, total: 1, totalPages: 1 },
  });
  result.items[0].name = 'changed';
  assert.equal(original.display_name, 'جهاز الاختبار');
  assert.equal(original.last_seen_at, '2026-11-09 10:20:30.123456');
});

test('people projection permits real person codes and strips notes and main-application identities', async () => {
  const { service } = fixture({ async pagePeople(query) {
    return page([person({ id: 7, notes: 'private', worker_id: 17, mapped_device_users: 2, created_at: 'private' })], query);
  } });
  assert.deepEqual((await service.listPeople()).items, [{ id: '7', personCode: '123', displayName: 'اسم الاختبار', status: 'active' }]);
});

test('events retain the source UUID and UTC precision while projecting only the portal read fields', async () => {
  const source = event({ notes: 'private', event_time_local: 'private', event_timezone: 'private', source_punch_id: 'private' });
  const { service } = fixture({ async pageFinalEvents(query) { return page([source], query); } });
  assert.deepEqual((await service.listEvents()).items, [{
    id: UUID, personCode: '123', personName: 'اسم الاختبار', eventType: 'check_in',
    eventTimeUtc: '2026-11-09T07:20:30.123456Z', verificationMethod: 'fingerprint', deviceName: 'جهاز الاختبار',
  }]);
  assert.equal(source.final_event_uuid, UUID);
});

test('supported filters normalize deliberately and all other input fields stay out of the read store', async () => {
  const { service, calls } = fixture();
  for (const method of ['listDevices', 'listPeople', 'listEvents']) {
    const result = await service[method]({ page: '2', limit: '100', search: '  اسم  ', status: 'live', personCode: 'ignored' });
    assert.equal(result.page.number, 2);
    assert.equal(result.page.limit, 100);
  }
  assert.deepEqual(calls, ['devices', 'people', 'events'].map(name => [name, { page: 2, limit: 100, search: 'اسم' }]));
  assert.equal((await service.listDevices({ page: 1_000_000, search: 'a'.repeat(100) })).page.number, 1_000_000);
});

test('invalid filters fail with stable input errors before querying the store', async () => {
  const { service, calls } = fixture();
  const invalidNumbers = [null, true, false, {}, [], '', ' 1', '1 ', '1x', '1.5', '1e2', '0x10', 0, -1, 1.5, Infinity, NaN];
  for (const method of ['listDevices', 'listPeople', 'listEvents']) {
    for (const value of invalidNumbers) {
      await assert.rejects(service[method]({ page: value }), invalidInput);
      await assert.rejects(service[method]({ limit: value }), invalidInput);
    }
    for (const filters of [null, [], { page: 1_000_001 }, { limit: 101 }, { search: 1 }, { search: null }, { search: 'x'.repeat(101) }]) {
      await assert.rejects(service[method](filters), invalidInput);
    }
  }
  assert.deepEqual(calls, []);
});

test('UTC conversion supports valid SQL dates, ISO UTC and Date values without silent calendar correction', async () => {
  const cases = [
    ['2024-02-29 23:59:59', '2024-02-29T23:59:59Z'],
    ['2000-02-29 00:00:00.1', '2000-02-29T00:00:00.1Z'],
    ['2026-11-09T07:20:30Z', '2026-11-09T07:20:30Z'],
    ['2026-11-09T07:20:30.123456Z', '2026-11-09T07:20:30.123456Z'],
    [new Date('2026-11-09T07:20:30.123Z'), '2026-11-09T07:20:30.123Z'],
  ];
  for (const [input, expected] of cases) {
    const { service } = fixture({ async pageFinalEvents(query) { return page([event({ event_time_utc: input })], query); } });
    assert.equal((await service.listEvents()).items[0].eventTimeUtc, expected);
  }
  for (const input of [null, undefined, '', 123, new Date(NaN), '0000-01-01 00:00:00', '1900-02-29 00:00:00',
    '2026-02-29 00:00:00', '2026-04-31T00:00:00Z', '2026-11-09 24:00:00', '2026-11-09 10:60:00',
    '2026-11-09 10:00:60', '2026-13-01 00:00:00', '2026-01-00 00:00:00', '2026-11-09T07:20:30',
    '2026-11-09T07:20:30+03:00', '2026-11-09 07:20:30Z', '2026-11-09 07:20:30.1234567']) {
    const { service } = fixture({ async pageFinalEvents(query) { return page([event({ event_time_utc: input })], query); } });
    await assert.rejects(service.listEvents(), invalidSource);
  }
});

test('optional device observation timestamps stay unknown when absent and reject malformed observations', async () => {
  for (const input of [null, undefined]) {
    const { service } = fixture({ async pageDevices(query) { return page([device({ last_seen_at: input })], query); } });
    assert.equal((await service.listDevices()).items[0].lastSeenAt, null);
  }
  const { service } = fixture({ async pageDevices(query) { return page([device({ last_seen_at: '2026-02-30 10:00:00' })], query); } });
  await assert.rejects(service.listDevices(), invalidSource);
});

test('SQL UTC mapping is independent of the process timezone', () => {
  const moduleUrl = new URL('../src/application/read-only-portal-service.js', import.meta.url).href;
  const script = `import { createReadOnlyPortalService } from ${JSON.stringify(moduleUrl)};
    const service = createReadOnlyPortalService({ readStore: {
      getDashboard() {}, pageDevices() {}, pagePeople() {}, async pageFinalEvents() {
        return ${JSON.stringify(page([event({ event_time_utc: '2026-11-09 07:20:30' })]))};
      }
    } });
    process.stdout.write((await service.listEvents()).items[0].eventTimeUtc);`;
  for (const timezone of ['Asia/Riyadh', 'Pacific/Honolulu']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env: { TZ: timezone }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '2026-11-09T07:20:30Z');
  }
});

test('malformed source IDs and paging metadata fail instead of inventing records or zero counts', async () => {
  for (const id of [null, undefined, 0, -1, '', '0', '1.5', Number.MAX_SAFE_INTEGER + 1]) {
    const { service } = fixture({ async pagePeople(query) { return page([person({ id })], query); } });
    await assert.rejects(service.listPeople(), invalidSource);
  }
  const badPages = [null, { items: [] }, { items: null, page: {} },
    { items: [], page: { number: 1, limit: 20, total: -1, totalPages: 1 } },
    { items: [], page: { number: 1, limit: 20, total: 100, totalPages: 1 } },
    { items: [], page: { number: 2, limit: 20, total: 0, totalPages: 1 } }];
  for (const result of badPages) {
    const { service } = fixture({ async pagePeople() { return result; } });
    await assert.rejects(service.listPeople(), invalidSource);
  }
  const { service } = fixture({ async getDashboard() { return { devices: { total: 1 }, people: { total: 2 } }; } });
  await assert.rejects(service.overview(), invalidSource);
});

test('store failures propagate unchanged without falling back to demo data or calling writes', async () => {
  const failure = new Error('test database unavailable');
  const writes = [];
  const methods = { overview: 'getDashboard', listDevices: 'pageDevices', listPeople: 'pagePeople', listEvents: 'pageFinalEvents' };
  for (const [serviceMethod, storeMethod] of Object.entries(methods)) {
    const { service } = fixture({
      async [storeMethod]() { throw failure; },
      async createPerson() { writes.push('create'); },
      async mapDeviceUser() { writes.push('map'); },
      async reprocessHistoricalEvents() { writes.push('replay'); },
    });
    await assert.rejects(service[serviceMethod](), error => error === failure);
  }
  assert.deepEqual(writes, []);
});

test('the adapter composes with TiDbAdminReadStore through parameterized, biometric-only read queries', async () => {
  const calls = [];
  const responses = [
    [{ total: 5, active: 2, test_mode: 1 }], [{ total: 8, active: 7 }], [{ total: 0 }], [{ total: 0 }], [{ total: 12 }],
    [{ total: 1 }], [device()], [{ total: 1 }], [person()], [{ total: 1 }], [event()],
  ];
  const pool = { async execute(sql, params = []) {
    calls.push({ sql, params });
    assert.ok(responses.length, 'unexpected query');
    return [responses.shift(), []];
  } };
  const service = createReadOnlyPortalService({ readStore: new TiDbAdminReadStore(pool) });
  assert.deepEqual((await service.overview()).counts, { devices: 5, people: 8, events: 12 });
  assert.equal((await service.listDevices()).items[0].id, '9007199254740993');
  assert.equal((await service.listPeople({ search: '12%' })).items[0].personCode, '123');
  assert.equal((await service.listEvents()).items[0].id, UUID);
  assert.equal(responses.length, 0);
  for (const { sql } of calls) {
    assert.match(sql.trim(), /^SELECT\b/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|workers|attendance_events|payroll|finance)\b/i);
  }
  assert.deepEqual(calls[7].params, ['%12\\%%', '%12\\%%']);
});
