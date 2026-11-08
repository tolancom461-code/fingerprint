import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonDirectoryReadService } from '../src/application/person-directory-read-service.js';

const rows = [
  { person_code: '900001', display_name: 'Ahmed One', status: 'active' },
  { person_code: '900002', display_name: 'Sara Two', status: 'active' },
  { person_code: '900003', display_name: 'Old Person', status: 'inactive' }
];

test('person directory exposes only safe stable linking fields', async () => {
  const calls = [];
  const service = new PersonDirectoryReadService({
    readStore: {
      async listPeople(options) {
        calls.push(options);
        return rows.slice(0, 2);
      }
    }
  });

  const page = await service.list({ search: '900', status: 'active', afterCode: '', limit: 100 });
  assert.deepEqual(page, {
    apiVersion: 'v1',
    items: [
      { personCode: '900001', displayName: 'Ahmed One', status: 'active' },
      { personCode: '900002', displayName: 'Sara Two', status: 'active' }
    ],
    page: { afterCode: '', nextAfterCode: '900002', limit: 100, hasMore: false }
  });
  assert.deepEqual(calls, [{ search: '900', status: 'active', afterCode: '', limit: 100 }]);

  const serialized = JSON.stringify(page);
  for (const forbidden of ['person_id', 'id":', 'notes', 'device_user', 'serial_number', 'worker_id', 'raw_', 'template', 'password']) {
    assert.equal(serialized.includes(forbidden), false, `directory leaked ${forbidden}`);
  }
});

test('person directory pagination is deterministic by person code', async () => {
  const service = new PersonDirectoryReadService({
    readStore: { async listPeople() { return rows; } }
  });
  const page = await service.list({ limit: 2, status: 'all' });
  assert.equal(page.items.length, 2);
  assert.equal(page.page.hasMore, true);
  assert.equal(page.page.nextAfterCode, '900002');
});

test('person directory validates search, status, cursor, and limit', async () => {
  const service = new PersonDirectoryReadService({ readStore: { async listPeople() { return []; } } });
  await assert.rejects(() => service.list({ status: 'unknown' }), /status must be/);
  await assert.rejects(() => service.list({ search: 'x'.repeat(121) }), /search is too long/);
  await assert.rejects(() => service.list({ afterCode: 'x'.repeat(65) }), /after_code is too long/);
  await assert.rejects(() => service.list({ limit: 0 }), /limit must be/);
});
