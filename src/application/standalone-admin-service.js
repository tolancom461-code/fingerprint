export class StandaloneAdminService {
  constructor({ managementService, adminReadStore, finalizationService, historicalReplayService = null }) {
    this.managementService = managementService;
    this.adminReadStore = adminReadStore;
    this.finalizationService = finalizationService;
    this.historicalReplayService = historicalReplayService;
  }

  async overview() {
    const [dashboard, devices, people, unmappedDeviceUsers, openIssues, recentFinalEvents] = await Promise.all([
      this.adminReadStore.getDashboard(),
      this.adminReadStore.listDevices({ limit: 100 }),
      this.adminReadStore.listPeople({ limit: 200 }),
      this.adminReadStore.listUnmappedDeviceUsers({ limit: 200 }),
      this.adminReadStore.listOpenIssues({ limit: 200 }),
      this.adminReadStore.listRecentFinalEvents({ limit: 100 })
    ]);
    return { dashboard, devices, people, unmappedDeviceUsers, openIssues, recentFinalEvents };
  }


  async listEvents(filters = {}) {
    return this.adminReadStore.pageFinalEvents(filters);
  }

  async exportEvents(filters = {}) {
    return this.adminReadStore.exportFinalEvents(filters);
  }

  async getEvent(finalEventUuid) {
    return this.adminReadStore.getFinalEventDetail(finalEventUuid);
  }

  async listPeople(filters = {}) {
    return this.adminReadStore.pagePeople(filters);
  }

  async listUnmappedDeviceUsers(filters = {}) {
    return this.adminReadStore.pageUnmappedDeviceUsers(filters);
  }

  async listIssues(filters = {}) {
    return this.adminReadStore.pageIssues(filters);
  }

  async listDevices(filters = {}) {
    return this.adminReadStore.pageDevices(filters);
  }

  async operationalReports(filters = {}) {
    return this.adminReadStore.getOperationalReports(filters);
  }



  async previewHistoricalEvents({ personId, from, to }) {
    if (!this.historicalReplayService) throw codedError('HISTORICAL_REPLAY_UNAVAILABLE', 'Historical replay is unavailable');
    return this.historicalReplayService.preview({ personId, from, to });
  }

  async reprocessHistoricalEvents({ personId, from, to, confirmed }, actor = localAdminActor()) {
    if (!this.historicalReplayService) throw codedError('HISTORICAL_REPLAY_UNAVAILABLE', 'Historical replay is unavailable');
    return this.historicalReplayService.reprocess({ personId, from, to, confirmed, actor });
  }

  async createPerson(input, actor = localAdminActor()) {
    return this.managementService.createPerson({ ...input, actor });
  }

  async onboardDeviceUser({ deviceUserRowId, displayName = null }, actor = localAdminActor()) {
    const result = await this.managementService.createPersonAndMapSuggestedDeviceUser({
      deviceUserRowId,
      displayName,
      actor
    });
    const reprocessed = await this.#reprocessOpenUnmappedIssues(deviceUserRowId);
    return { ...result, reprocessed };
  }

  async mapDeviceUser({ deviceUserRowId, personId }, actor = localAdminActor()) {
    const result = await this.managementService.mapDeviceUser({ deviceUserRowId, personId, actor });
    const reprocessed = await this.#reprocessOpenUnmappedIssues(deviceUserRowId);
    return { ...result, reprocessed };
  }

  async #reprocessOpenUnmappedIssues(deviceUserRowId) {
    const punchIds = await this.adminReadStore.listOpenUnmappedPunchIdsForDeviceUserRowId(deviceUserRowId, { limit: 100 });
    const results = [];
    for (const punchId of punchIds) {
      try {
        results.push(await this.finalizationService.finalizePunchById(punchId));
      } catch (error) {
        results.push({ status: 'error', sourcePunchId: punchId, errorCode: error?.code ?? 'FINALIZATION_ERROR' });
      }
    }
    return results;
  }
}

function codedError(code, message) { const error = new Error(message); error.code = code; return error; }

function localAdminActor() {
  return { actorType: 'admin', actorReference: 'local-ui' };
}
