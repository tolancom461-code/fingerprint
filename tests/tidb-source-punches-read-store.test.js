import test from 'node:test';
import assert from 'node:assert/strict';
import { TiDbSourcePunchesReadStore } from '../src/infrastructure/storage/tidb-source-punches-read-store.js';

function fixture(options) {
  const calls = [];
  const store = new TiDbSourcePunchesReadStore({ async execute(sql, params) {
    calls.push({ sql, params }); return [[], []];
  } }, options);
  return { store, calls };
}

test('source query uses canonical punches independent of final events, people and mutable directory rows', async () => {
  const { store, calls } = fixture({ deviceUserIdentityEnabled: true });
  await store.listSourcePunchesAfter('18446744073709551614', 100);
  const { sql, params } = calls[0];
  assert.match(sql, /FROM `biometric_svc_punches` p/);
  assert.match(sql, /p\.id > CAST\(\? AS DECIMAL\(20,0\)\)/);
  assert.match(sql, /ORDER BY p\.id ASC\s+LIMIT 101/);
  assert.match(sql, /CAST\(p\.id AS CHAR\) AS id/);
  assert.match(sql, /CAST\(p\.device_user_row_id AS CHAR\) AS device_user_row_id/);
  assert.match(sql, /DATE_FORMAT\(p\.device_event_time_utc, '%Y-%m-%dT%H:%i:%s\.%fZ'\)/);
  assert.doesNotMatch(sql, /JOIN|final_events|people|person_code|display_name|safe_payload|verification_method/);
  assert.deepEqual(params, ['18446744073709551614', 'AJE1261900133']);
});

test('historical fallback is constrained to the proven profile before pagination and preserves NULL identity', async () => {
  const { store, calls } = fixture();
  await store.listSourcePunchesAfter('0002', 1);
  const { sql, params } = calls[0];
  assert.match(sql, /NULL AS device_user_row_id/);
  assert.doesNotMatch(sql, /p\.device_user_row_id/);
  assert.match(sql, /p\.raw_status IN \('0', '1', '2', '3', '4', '5'\)/);
  assert.match(sql, /p\.device_event_time_utc IS NOT NULL/);
  assert.match(sql, /p\.punch_state IS NULL AND p\.vendor = 'zkteco' AND p\.serial_number IN \(\?\)/);
  assert.match(sql, /COALESCE\(p\.punch_state, CASE p\.raw_status/);
  assert.match(sql, /p\.punch_state = CASE p\.raw_status/);
  assert.deepEqual(params, ['2', 'AJE1261900133']);
});

test('store independently validates paging and performs only one read', async () => {
  const { store, calls } = fixture();
  for (const afterId of ['-1', '1;DROP TABLE t', '18446744073709551616', 9007199254740992, null]) {
    await assert.rejects(store.listSourcePunchesAfter(afterId, 1), { code: 'INVALID_INPUT' });
  }
  for (const limit of [0, 501, '1.1', true]) {
    await assert.rejects(store.listSourcePunchesAfter('0', limit), { code: 'INVALID_INPUT' });
  }
  assert.equal(calls.length, 0);
  await store.listSourcePunchesAfter('0', 500);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^SELECT /);
  assert.match(calls[0].sql, /LIMIT 501$/);
});
