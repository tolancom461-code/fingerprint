import test from 'node:test';
import assert from 'node:assert/strict';
import { StandaloneManagementService } from '../src/application/standalone-management-service.js';

function fixture(overrides = {}) {
  const people = new Map();
  const byCode = new Map();
  const users = new Map([[7, { id: 7, device_id: 1, device_user_id: '175', display_name: 'Ahmed' }]]);
  const mappings = new Map();
  const audits = [];
  let personId = 10;
  let mappingId = 20;

  const peopleStore = {
    async getPersonById(id) { return people.get(Number(id)) ?? null; },
    async getPersonByCode(code) { return byCode.get(String(code)) ?? null; },
    async createPerson(input) {
      if (byCode.has(input.personCode)) { const e = new Error('duplicate'); e.code = 'PERSON_CODE_CONFLICT'; throw e; }
      const row = { id: ++personId, person_code: input.personCode, display_name: input.displayName, status: input.status, notes: input.notes };
      people.set(row.id, row); byCode.set(row.person_code, row); return row;
    }
  };
  const mappingStore = {
    async getDeviceUserByRowId(id) { return users.get(Number(id)) ?? null; },
    async getMappingByDeviceUserRowId(id) { return mappings.get(Number(id)) ?? null; },
    async createMapping(input) {
      if (mappings.has(Number(input.deviceUserRowId))) { const e = new Error('duplicate'); e.code = 'DEVICE_USER_MAPPING_CONFLICT'; throw e; }
      const row = { id: ++mappingId, person_id: input.personId, device_user_row_id: input.deviceUserRowId, status: input.status, active_from: 'now', active_to: null };
      mappings.set(Number(input.deviceUserRowId), row); return row;
    }
  };
  const auditStore = { async append(entry) { audits.push(entry); return { id: audits.length }; } };
  return { service: new StandaloneManagementService({ peopleStore, mappingStore, auditStore }), people, byCode, users, mappings, audits, ...overrides };
}

test('suggests device_user_id as person_code for an unmapped device user', async () => {
  const { service } = fixture();
  const result = await service.suggestPersonForDeviceUser(7);
  assert.equal(result.state, 'new_person_suggested');
  assert.equal(result.suggestedPersonCode, '175');
  assert.equal(result.suggestedDisplayName, 'Ahmed');
});

test('suggests an existing person when person_code already matches the device user id', async () => {
  const f = fixture();
  const person = { id: 99, person_code: '175', display_name: 'Ahmed Existing', status: 'active' };
  f.people.set(99, person); f.byCode.set('175', person);
  const result = await f.service.suggestPersonForDeviceUser(7);
  assert.equal(result.state, 'existing_person_suggested');
  assert.equal(result.existingPerson.id, 99);
});

test('creates person and mapping with safe audit records', async () => {
  const f = fixture();
  const result = await f.service.createPersonAndMapSuggestedDeviceUser({ deviceUserRowId: 7, actor: { actorType: 'admin', actorReference: 'operator-1' } });
  assert.equal(result.person.person_code, '175');
  assert.equal(result.createdPerson, true);
  assert.equal(result.createdMapping, true);
  assert.equal(f.audits.length, 2);
  assert.equal(f.audits[0].actionType, 'person_created');
  assert.equal(f.audits[1].actionType, 'device_user_mapped');
  assert.equal(JSON.stringify(f.audits).includes('template'), false);
});

test('requires a display name when a new person cannot inherit one from the device', async () => {
  const f = fixture();
  f.users.set(8, { id: 8, device_id: 1, device_user_id: '176', display_name: null });
  await assert.rejects(
    f.service.createPersonAndMapSuggestedDeviceUser({ deviceUserRowId: 8 }),
    (error) => error.code === 'DISPLAY_NAME_REQUIRED'
  );
});

test('does not remap a device user to a different person', async () => {
  const f = fixture();
  const p1 = { id: 1, person_code: '1', display_name: 'One', status: 'active' };
  const p2 = { id: 2, person_code: '2', display_name: 'Two', status: 'active' };
  f.people.set(1, p1); f.people.set(2, p2);
  f.mappings.set(7, { id: 4, person_id: 1, device_user_row_id: 7, status: 'active' });
  await assert.rejects(f.service.mapDeviceUser({ personId: 2, deviceUserRowId: 7 }), (e) => e.code === 'DEVICE_USER_MAPPING_CONFLICT');
});

test('mapping same active person and device user is idempotent', async () => {
  const f = fixture();
  const person = { id: 1, person_code: '175', display_name: 'Ahmed', status: 'active' };
  f.people.set(1, person);
  f.mappings.set(7, { id: 4, person_id: 1, device_user_row_id: 7, status: 'active' });
  const result = await f.service.mapDeviceUser({ personId: 1, deviceUserRowId: 7 });
  assert.equal(result.created, false);
  assert.equal(f.audits.length, 0);
});

test('inactive person cannot receive a new device-user mapping', async () => {
  const f = fixture();
  f.people.set(1, { id: 1, person_code: '175', display_name: 'Ahmed', status: 'inactive' });
  await assert.rejects(f.service.mapDeviceUser({ personId: 1, deviceUserRowId: 7 }), (e) => e.code === 'PERSON_INACTIVE');
});
