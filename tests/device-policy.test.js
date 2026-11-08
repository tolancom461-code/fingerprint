import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeviceRequestPolicy, evaluateDeviceEventPolicy } from '../src/domain/device-policy.js';

test('active test/live device modes are accepted and unknown modes fail closed', () => {
  assert.equal(evaluateDeviceRequestPolicy({ status: 'active', mode: 'test' }).allowed, true);
  assert.equal(evaluateDeviceRequestPolicy({ status: 'active', mode: 'live' }).allowed, true);
  assert.equal(evaluateDeviceRequestPolicy({ status: 'disabled', mode: 'live' }).allowed, false);
  assert.equal(evaluateDeviceRequestPolicy({ status: 'active', mode: 'mystery' }).allowed, false);
});

test('accept_events_from keeps old safe events durable but not canonical eligible', () => {
  const device = { status: 'active', mode: 'test', timezone: 'Asia/Riyadh', accept_events_from: '2026-08-30 12:00:00.000000' };
  const old = evaluateDeviceEventPolicy(device, '2026-08-30 14:59:59');
  const equal = evaluateDeviceEventPolicy(device, '2026-08-30 15:00:00');
  const newer = evaluateDeviceEventPolicy(device, '2026-08-30 15:00:01');
  assert.equal(old.allowed, true);
  assert.equal(old.canonicalEligible, false);
  assert.equal(old.reason, 'before_accept_events_from');
  assert.equal(equal.canonicalEligible, true);
  assert.equal(newer.canonicalEligible, true);
});

test('invalid accept_events_from fails closed', () => {
  const policy = evaluateDeviceEventPolicy({ status: 'active', mode: 'live', timezone: 'Asia/Riyadh', accept_events_from: 'not-a-date' }, '2026-08-30 15:00:00');
  assert.equal(policy.allowed, true);
  assert.equal(policy.canonicalEligible, false);
  assert.equal(policy.reason, 'invalid_accept_events_from');
});


test('accept_events_from compares absolute UTC instants across device timezones', () => {
  const cutoffUtc = '2026-08-31 06:55:18.369722';
  const riyadh = { status: 'active', mode: 'test', timezone: 'Asia/Riyadh', accept_events_from: cutoffUtc };
  assert.equal(evaluateDeviceEventPolicy(riyadh, '2026-08-31 09:55:17').canonicalEligible, false);
  assert.equal(evaluateDeviceEventPolicy(riyadh, '2026-08-31 09:55:19').canonicalEligible, true);

  const london = { status: 'active', mode: 'live', timezone: 'Europe/London', accept_events_from: cutoffUtc };
  assert.equal(evaluateDeviceEventPolicy(london, '2026-08-31 07:55:17').canonicalEligible, false);
  assert.equal(evaluateDeviceEventPolicy(london, '2026-08-31 07:55:19').canonicalEligible, true);
});

test('cutoff fails canonical processing closed when device timezone cannot convert event time', () => {
  const policy = evaluateDeviceEventPolicy(
    { status: 'active', mode: 'test', timezone: 'Invalid/Zone', accept_events_from: '2026-08-31 06:55:18.000000' },
    '2026-08-31 09:55:18'
  );
  assert.equal(policy.allowed, true);
  assert.equal(policy.canonicalEligible, false);
  assert.equal(policy.reason, 'invalid_event_time_for_accept_events_from');
});
