export class FinalizationStore {
  async getPunchContext(_punchId) { throw new Error('not implemented'); }
  async createFinalEvent(_event) { throw new Error('not implemented'); }
  async upsertIssue(_issue) { throw new Error('not implemented'); }
  async resolveOpenIssues(_sourcePunchId, _resolutionNote) { throw new Error('not implemented'); }
}
