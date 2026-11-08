import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbAuditStore } from '../src/infrastructure/storage/tidb-audit-store.js';

test('audit store serializes only supplied safe snapshots', async () => {
  let call;
  const pool = { async execute(sql, params) { call = { sql, params }; return [{ insertId: 5 }]; } };
  const store = new TiDbAuditStore(pool);
  const result = await store.append({
    actorType: 'admin', actorReference: 'operator-1', actionType: 'person_created', entityType: 'person', entityId: 3,
    afterState: { personCode: '175', displayName: 'Ahmed' }
  });
  assert.equal(result.id, 5);
  assert.equal(call.params[0], 'admin');
  assert.equal(call.params[6], JSON.stringify({ personCode: '175', displayName: 'Ahmed' }));
});
