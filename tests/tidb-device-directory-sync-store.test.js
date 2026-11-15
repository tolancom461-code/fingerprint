import assert from 'node:assert/strict';
import test from 'node:test';
import { TiDbDeviceDirectorySyncStore } from '../src/infrastructure/storage/tidb-device-directory-sync-store.js';

const DEVICE_ID = '9007199254740993';
const device = { vendor: 'zkteco', serialNumber: 'SYNTHETIC-DIRECTORY-DEVICE' };
const iso = day => `2026-11-${String(day).padStart(2, '0')}T05:00:00.000Z`;
const sqlTime = day => iso(day).slice(0, -1).replace('T', ' ') + '000';
const profile = (deviceUserId, displayName, options) => ({ deviceUserId, displayName, ...options });
const observation = (day, profiles) => ({ device, observedAtUtc: iso(day), userCount: profiles.length, profiles });
const user = (id, device_user_id, display_name, changes) => ({ id, device_user_id, display_name, status: 'seen',
  first_seen_at: sqlTime(1), last_seen_at: sqlTime(1), identity_started_at: null, identity_ended_at: null,
  safe_metadata: null, ...changes });

function fixture(users = []) {
  const state = { users, audit: [], punches: [], mappings: [], status: 'active', mode: 'test', failAction: null, connections: 0,
    commits: 0, rollbacks: 0, queryLog: [] };
  let previousLock = Promise.resolve();
  let nextId = 9007199254741099n;
  const pool = {
    async execute(sql, params) {
      assert.match(sql, /^SELECT id FROM `biometric_svc_devices`/);
      assert.deepEqual(params, [device.vendor, device.serialNumber]);
      return [[{ id: DEVICE_ID }]];
    },
    async getConnection() {
      state.connections++;
      let draft;
      let transaction = false;
      let unlock;
      function finish() {
        assert.equal(transaction, true);
        transaction = false;
        unlock?.();
      }
      return {
        async beginTransaction(options) {
          assert.deepEqual(options, { readCommitted: true });
          transaction = true;
        },
        async execute(rawSql, params) {
          assert.equal(transaction, true);
          const sql = rawSql.replace(/\s+/g, ' ').trim();
          state.queryLog.push(sql);
          if (sql === 'SELECT id FROM `biometric_svc_devices` WHERE id = ? FOR UPDATE') {
            assert.deepEqual(params, [DEVICE_ID]);
            const prior = previousLock;
            previousLock = new Promise(resolve => { unlock = resolve; });
            await prior;
            draft = structuredClone({ users: state.users, audit: state.audit });
            return [[{ id: DEVICE_ID }]];
          }
          assert.ok(draft, 'the device lock must precede other reads and writes');
          if (sql.startsWith('SELECT id, vendor, serial_number, status, mode')) {
            return [[{ id: DEVICE_ID, vendor: device.vendor, serial_number: device.serialNumber, status: state.status, mode: state.mode }]];
          }
          if (sql.startsWith('SELECT after_state ')) {
            assert.match(sql, /ORDER BY JSON_UNQUOTE\(JSON_EXTRACT\(after_state, '\$\.observedAtUtc'\)\) DESC, id DESC LIMIT 1$/);
            const latest = draft.audit.filter(row => row.action === 'device_user_directory_checkpoint').at(-1);
            return [latest ? [{ after_state: JSON.stringify(latest.after) }] : []];
          }
          if (sql.startsWith('SELECT id, device_user_id, display_name')) {
            assert.match(sql, /safe_metadata.*FOR UPDATE$/);
            return [structuredClone(draft.users)];
          }
          if (sql.startsWith('SELECT device_event_time_utc')) {
            assert.match(sql, /device_user_row_id = \? ORDER BY device_event_time_utc DESC LIMIT 1$/);
            const latest = state.punches.filter(row => row.device_user_row_id === params[0])
              .map(row => row.device_event_time_utc).filter(Boolean).sort().at(-1);
            return [latest ? [{ device_event_time_utc: latest }] : []];
          }
          if (sql.startsWith('INSERT INTO `biometric_svc_device_users`')) {
            const [deviceId, pin, name, metadata, start, firstSeen, lastSeen] = params;
            assert.equal(deviceId, DEVICE_ID);
            assert.equal(draft.users.some(row => row.device_user_id === pin && row.status !== 'absent_from_device'), false);
            nextId++;
            const id = String(nextId);
            draft.users.push(user(id, pin, name, { safe_metadata: metadata, identity_started_at: start,
              first_seen_at: firstSeen, last_seen_at: lastSeen }));
            return [{ affectedRows: 1, insertId: id }];
          }
          if (sql.startsWith('UPDATE `biometric_svc_device_users`')) {
            const [a, b, id, deviceId, status] = params;
            const row = draft.users.find(value => value.id === id && value.status === status);
            assert.equal(deviceId, DEVICE_ID);
            assert.ok(row);
            if (sql.includes('SET display_name')) Object.assign(row, { display_name: a, safe_metadata: b });
            else Object.assign(row, { status: a, identity_ended_at: b });
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith('INSERT INTO `biometric_svc_audit_log`')) {
            const [actor, reference, action, entity, entityId, before, after, notes] = params;
            if (action === state.failAction) throw new Error('PRIVATE DATABASE DRIVER DETAILS');
            assert.deepEqual([actor, reference, notes], ['system', 'verified-device-directory', null]);
            draft.audit.push({ action, entity, entityId, before: before == null ? null : JSON.parse(before), after: JSON.parse(after) });
            return [{ affectedRows: 1 }];
          }
          assert.fail('unexpected SQL: ' + sql);
        },
        async commit() {
          Object.assign(state, draft);
          state.commits++;
          finish();
        },
        async rollback() { state.rollbacks++; finish(); },
        release() { assert.equal(transaction, false); }
      };
    }
  };
  return { store: new TiDbDeviceDirectorySyncStore(pool), pool, state };
}

function lifecycle(state) { return state.audit.filter(row => row.entity === 'device_user'); }

test('baseline avoids phantom additions, reports real additions/edits and preserves omitted fields', async () => {
  const { store, state } = fixture([user('11', '001', 'Original Name', { safe_metadata: '{"Pri":"0","Grp":"1","other":"keep"}' })]);
  const baseline = await store.reconcile(observation(2, [profile('001', 'Original Name', { metadata: { Pri: '0' } })]));
  assert.deepEqual(baseline, { addedCount: 0, updatedCount: 0, archivedCount: 0, pendingRemovalCount: 0, replayed: false });
  const changed = await store.reconcile(observation(3, [
    profile('001', null, { nameReported: false, metadata: { Pri: '1' } }), profile('002', 'Added Name')
  ]));
  assert.equal(changed.updatedCount, 1);
  assert.equal(changed.addedCount, 1);
  assert.equal(state.users[0].display_name, 'Original Name');
  assert.deepEqual(JSON.parse(state.users[0].safe_metadata), { Pri: '1', Grp: '1', other: 'keep' });
  const [updated, added] = lifecycle(state);
  assert.deepEqual(updated, { action: 'device_user_updated', entity: 'device_user', entityId: '11',
    before: { deviceUserId: '001', displayName: 'Original Name', status: 'seen', metadata: { Pri: '0', Grp: '1' } },
    after: { deviceUserId: '001', displayName: 'Original Name', status: 'seen', metadata: { Pri: '1', Grp: '1' } } });
  assert.equal(added.entityId, '9007199254741100');
  assert.deepEqual(added.after, { deviceUserId: '002', displayName: 'Added Name', status: 'seen' });
  const checkpoints = state.audit.filter(row => row.action === 'device_user_directory_checkpoint');
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(checkpoints[1].after, { version: 1, observedAtUtc: iso(3),
    rosterSha256: checkpoints[1].after.rosterSha256, pins: ['001', '002'], missingIdentities: [] });
  assert.match(checkpoints[1].after.rosterSha256, /^[a-f0-9]{64}$/);
  const blank = await store.reconcile(observation(4, [profile('001', null), profile('002', 'Added Name')]));
  assert.equal(blank.updatedCount, 1);
  assert.equal(state.users[0].display_name, null);
});

test('two fresh missing snapshots retire once and reappearing PIN receives a separate identity', async () => {
  const { pool, store, state } = fixture([user('11', '001', 'Old Name')]);
  state.punches.push({ device_user_row_id: '11', device_event_time_utc: sqlTime(1) });
  state.mappings.push({ device_user_row_id: '11', person_id: '31' });
  const first = await store.reconcile(observation(2, []));
  assert.equal(first.pendingRemovalCount, 1);
  assert.equal(first.archivedCount, 0);
  assert.deepEqual(state.audit[0].after.missingIdentities, ['11']);
  const restarted = new TiDbDeviceDirectorySyncStore(pool);
  assert.equal((await restarted.reconcile(observation(2, []))).replayed, true);
  assert.equal(state.users[0].status, 'seen');
  assert.equal((await restarted.reconcile(observation(3, []))).archivedCount, 1);
  assert.equal(state.users[0].status, 'absent_from_device');
  assert.equal(state.users[0].identity_ended_at, sqlTime(2));
  assert.equal(lifecycle(state)[0].before.displayName, 'Old Name');
  assert.equal(lifecycle(state)[0].after.status, 'absent_from_device');

  const reused = await restarted.reconcile(observation(4, [profile('001', 'New Enrollment')]));
  assert.equal(reused.addedCount, 1);
  assert.equal(state.users[0].display_name, 'Old Name');
  assert.equal(state.users[1].identity_started_at, sqlTime(4));
  assert.notEqual(state.users[1].id, '11');
  assert.deepEqual(state.punches, [{ device_user_row_id: '11', device_event_time_utc: sqlTime(1) }]);
  assert.deepEqual(state.mappings, [{ device_user_row_id: '11', person_id: '31' }]);
});

test('absence interrupted by presence clears confirmation and late bound movements protect the earlier cutoff', async () => {
  const { store, state } = fixture([user('11', '001', 'Old Name')]);
  await store.reconcile(observation(2, []));
  await store.reconcile(observation(3, [profile('001', 'Old Name')]));
  assert.equal((await store.reconcile(observation(4, []))).archivedCount, 0);
  state.punches.push({ device_user_row_id: '11', device_event_time_utc: sqlTime(4) });
  const blocked = await store.reconcile(observation(5, []));
  assert.equal(blocked.archivedCount, 0);
  assert.equal(blocked.pendingRemovalCount, 1);
  assert.equal((await store.reconcile(observation(6, []))).archivedCount, 1);
  assert.equal(state.users[0].identity_ended_at, sqlTime(5));
});

test('a later punch placeholder keeps its identity and gets a single device addition audit', async () => {
  const { store, state } = fixture([user('11', '001', 'Existing')]);
  await store.reconcile(observation(2, [profile('001', 'Existing')]));
  state.users.push(user('12', '002', null, { first_seen_at: sqlTime(3), last_seen_at: sqlTime(3) }));
  const next = observation(4, [profile('001', 'Existing'), profile('002', 'New Enrollment')]);
  assert.equal((await store.reconcile(next)).addedCount, 1);
  assert.equal((await store.reconcile({ ...next, profiles: [...next.profiles].reverse() })).replayed, true);
  assert.equal(state.users.length, 2);
  assert.equal(state.users[1].id, '12');
  assert.equal(lifecycle(state).length, 1);
  assert.equal(lifecycle(state)[0].entityId, '12');
  assert.equal(lifecycle(state)[0].after.displayName, 'New Enrollment');
});

test('concurrent identical observations serialize and mismatched or older checkpoints fail without mutations', async () => {
  const { store, state } = fixture();
  const snapshot = observation(3, [profile('001', 'First')]);
  const [first, second] = await Promise.all([store.reconcile(snapshot), store.reconcile(snapshot)]);
  assert.equal(first.addedCount + second.addedCount, 1);
  assert.equal([first, second].filter(result => result.replayed).length, 1);
  assert.equal(state.commits, 1);
  assert.equal(state.users.length, 1);
  for (const value of [observation(3, [profile('001', 'Mismatch')]), observation(2, [])]) {
    await assert.rejects(store.reconcile(value), { code: 'DEVICE_DIRECTORY_STALE_OBSERVATION' });
  }
  assert.equal(state.commits, 1);
  assert.equal(state.audit.length, 2);
});

test('checkpoint rejects invalid digests and noncanonical or duplicated key lists', async () => {
  const { store, state } = fixture();
  await store.reconcile(observation(2, [profile('002', null), profile('001', null)]));
  const row = state.audit.at(-1);
  const original = structuredClone(row.after);
  for (const patch of [{ rosterSha256: 'raw name' }, { pins: ['002', '001'] }, { pins: ['001', '001'] },
    { missingIdentities: ['11', '11'] }]) {
    row.after = { ...original, ...patch };
    await assert.rejects(store.reconcile(observation(3, [])), { code: 'DEVICE_DIRECTORY_CHECKPOINT_INVALID' });
  }
  assert.equal(state.commits, 1);
});

test('audit or checkpoint failure rolls back changes and only safe error details leave the store', async () => {
  const { store, state } = fixture([user('11', '001', 'Original')]);
  state.failAction = 'device_user_directory_checkpoint';
  await assert.rejects(store.reconcile(observation(2, [profile('001', 'New Name'), profile('002', 'New User')])), error => {
    assert.equal(error.code, 'DEVICE_DIRECTORY_SYNC_FAILED');
    assert.equal(error.cause, undefined);
    assert.equal(error.stack.includes('PRIVATE DATABASE DRIVER DETAILS'), false);
    return true;
  });
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].display_name, 'Original');
  assert.deepEqual(state.audit, []);
  assert.equal(state.rollbacks, 1);
});

test('invalid or incomplete evidence fails before opening any connection and policy is checked under the lock', async () => {
  const { store, state } = fixture();
  const valid = observation(2, [profile('001', 'First')]);
  for (const value of [
    { ...valid, userCount: 2 },
    observation(2, [profile('001', 'First'), profile('001', 'Second')]),
    observation(2, [profile('001', 'First', { metadata: { Password: 'PRIVATE' } })]),
    observation(2, [profile('001', 'First', { metadata: { Pri: '[REDACTED]' } })]),
    observation(2, [profile('001', 'First', { nameReported: null })]),
    observation(2, Array.from({ length: 10001 }, (_, index) => profile(String(index), 'Bounded Batch'))),
    { ...valid, observedAtUtc: '2026-02-30T00:00:00.000Z' }
  ]) await assert.rejects(store.reconcile(value), { code: 'DEVICE_DIRECTORY_OBSERVATION_REJECTED' });
  assert.equal(state.connections, 0);
  state.status = 'disabled';
  await assert.rejects(store.reconcile(valid), { code: 'DEVICE_DIRECTORY_DEVICE_REJECTED' });
  state.status = 'active';
  state.mode = 'blocked';
  await assert.rejects(store.reconcile(valid), { code: 'DEVICE_DIRECTORY_DEVICE_REJECTED' });
  assert.equal(state.connections, 2);
  assert.equal(state.commits, 0);
  assert.equal(state.audit.length, 0);
});
