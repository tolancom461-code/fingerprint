import test from 'node:test';
import assert from 'node:assert/strict';
import { StandaloneAdminService } from '../src/application/standalone-admin-service.js';

test('overview keeps the local UI simple by composing the required read models', async () => {
  const adminReadStore = {
    async getDashboard() { return { people: { active: 2 } }; },
    async listDevices() { return [{ id: 1 }]; },
    async listPeople() { return [{ id: 2 }]; },
    async listUnmappedDeviceUsers() { return [{ id: 3 }]; },
    async listOpenIssues() { return [{ id: 4 }]; },
    async listRecentFinalEvents() { return [{ id: 5 }]; },
    async listOpenUnmappedPunchIdsForDeviceUserRowId() { return []; }
  };
  const service = new StandaloneAdminService({ managementService: {}, adminReadStore, finalizationService: {} });
  const result = await service.overview();
  assert.equal(result.devices[0].id, 1);
  assert.equal(result.unmappedDeviceUsers[0].id, 3);
  assert.equal(result.recentFinalEvents[0].id, 5);
});

test('onboarding immediately retries only open unmapped issues for that device user', async () => {
  const finalized = [];
  const managementService = {
    async createPersonAndMapSuggestedDeviceUser(input) {
      assert.equal(input.deviceUserRowId, 60001);
      assert.equal(input.actor.actorType, 'admin');
      return { person: { id: 30001 }, mapping: { id: 1 }, createdPerson: true, createdMapping: true };
    }
  };
  const adminReadStore = {
    async listOpenUnmappedPunchIdsForDeviceUserRowId(id, options) {
      assert.equal(id, 60001); assert.equal(options.limit, 100); return [60001, 60002];
    }
  };
  const finalizationService = {
    async finalizePunchById(id) { finalized.push(id); return { status: 'final', sourcePunchId: id }; }
  };
  const service = new StandaloneAdminService({ managementService, adminReadStore, finalizationService });
  const result = await service.onboardDeviceUser({ deviceUserRowId: 60001, displayName: 'Test' });
  assert.deepEqual(finalized, [60001, 60002]);
  assert.equal(result.reprocessed.length, 2);
});

test('manual mapping also retries targeted unresolved punches and contains individual failures', async () => {
  const managementService = { async mapDeviceUser() { return { mapping: { id: 9 }, created: true }; } };
  const adminReadStore = { async listOpenUnmappedPunchIdsForDeviceUserRowId() { return [10, 11]; } };
  const finalizationService = {
    async finalizePunchById(id) { if (id === 11) throw Object.assign(new Error('boom'), { code: 'TEST_FAILURE' }); return { status: 'final', sourcePunchId: id }; }
  };
  const service = new StandaloneAdminService({ managementService, adminReadStore, finalizationService });
  const result = await service.mapDeviceUser({ deviceUserRowId: 7, personId: 2 });
  assert.equal(result.reprocessed[0].status, 'final');
  assert.deepEqual(result.reprocessed[1], { status: 'error', sourcePunchId: 11, errorCode: 'TEST_FAILURE' });
});

test('read-only admin reporting methods delegate only to the biometric admin read store', async () => {
  const calls = [];
  const adminReadStore = {
    async pageFinalEvents(filters) { calls.push(['events', filters]); return { items: [] }; },
    async exportFinalEvents(filters) { calls.push(['export', filters]); return []; },
    async getFinalEventDetail(id) { calls.push(['event', id]); return { final_event_uuid: id }; },
    async pagePeople(filters) { calls.push(['people', filters]); return { items: [] }; },
    async pageUnmappedDeviceUsers(filters) { calls.push(['unmapped', filters]); return { items: [] }; },
    async pageIssues(filters) { calls.push(['issues', filters]); return { items: [] }; },
    async pageDevices(filters) { calls.push(['devices', filters]); return { items: [] }; },
    async getOperationalReports(filters) { calls.push(['reports', filters]); return { systemHealth: {} }; }
  };
  const service = new StandaloneAdminService({ managementService: {}, adminReadStore, finalizationService: {} });
  await service.listEvents({ page: 2 });
  await service.exportEvents({ search: '900' });
  await service.getEvent('11111111-1111-4111-8111-111111111111');
  await service.listPeople({ status: 'active' });
  await service.listUnmappedDeviceUsers({ deviceId: 1 });
  await service.listIssues({ status: 'resolved' });
  await service.listDevices({ mode: 'test' });
  await service.operationalReports({ from: '2026-09-01' });
  assert.deepEqual(calls.map((entry) => entry[0]), ['events', 'export', 'event', 'people', 'unmapped', 'issues', 'devices', 'reports']);
});

test('historical preview and reprocessing delegate only to the explicit manual replay service', async () => {
  const calls = [];
  const historicalReplayService = {
    async preview(input) { calls.push(['preview', input]); return { count: 1 }; },
    async reprocess(input) { calls.push(['reprocess', input]); return { reissuedCount: 1 }; }
  };
  const service = new StandaloneAdminService({ managementService: {}, adminReadStore: {}, finalizationService: {}, historicalReplayService });
  assert.deepEqual(await service.previewHistoricalEvents({ personId: 30001, from: '2026-09-01', to: '2026-09-01' }), { count: 1 });
  assert.deepEqual(await service.reprocessHistoricalEvents({ personId: 30001, from: '2026-09-01', to: '2026-09-01', confirmed: true }), { reissuedCount: 1 });
  assert.equal(calls[1][1].actor.actorType, 'admin');
  assert.equal(calls[1][1].actor.actorReference, 'local-ui');
});
