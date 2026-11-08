import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZktecoAttendance } from '../src/infrastructure/vendors/zkteco/attlog-normalization.js';

const SERIAL = 'AJE1261900133';

test('normalizes the punch-state codes proven on the tested SpeedFace terminal', () => {
  const expected = new Map([
    ['0', 'check_in'],
    ['1', 'check_out'],
    ['2', 'break_out'],
    ['3', 'break_in'],
    ['4', 'overtime_in'],
    ['5', 'overtime_out']
  ]);
  for (const [rawStatus, punchState] of expected) {
    assert.equal(normalizeZktecoAttendance({ serialNumber: SERIAL, rawStatus, rawVerify: '1' }).punchState, punchState);
  }
  assert.equal(normalizeZktecoAttendance({ serialNumber: SERIAL, rawStatus: '255', rawVerify: '1' }).punchState, null);
  assert.equal(normalizeZktecoAttendance({ serialNumber: SERIAL, rawStatus: '999', rawVerify: '1' }).punchState, null);
});

test('normalizes the verification codes proven on the tested SpeedFace terminal', () => {
  const expected = new Map([
    ['1', 'fingerprint'],
    ['3', 'password'],
    ['4', 'card'],
    ['15', 'face'],
    ['25', 'palm']
  ]);
  for (const [rawVerify, verificationMethod] of expected) {
    assert.equal(normalizeZktecoAttendance({ serialNumber: SERIAL, rawStatus: '0', rawVerify }).verificationMethod, verificationMethod);
  }
  assert.equal(normalizeZktecoAttendance({ serialNumber: SERIAL, rawStatus: '0', rawVerify: '999' }).verificationMethod, null);
});

test('does not assume the tested numeric mappings for another ZKTeco serial number', () => {
  const result = normalizeZktecoAttendance({ serialNumber: 'UNVALIDATED-ZK', rawStatus: '0', rawVerify: '1' });
  assert.equal(result.profileId, null);
  assert.equal(result.punchState, null);
  assert.equal(result.verificationMethod, null);
});
