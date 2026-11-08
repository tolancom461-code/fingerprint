import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAdmsRequestUrl,
  parseAttlogBody,
  looksLikeBiometricTemplateTable
} from '../src/infrastructure/vendors/zkteco/adms-parser.js';

test('parses serial number case-insensitively', () => {
  assert.equal(parseAdmsRequestUrl('/iclock/cdata?SN=ABC123').serialNumber, 'ABC123');
  assert.equal(parseAdmsRequestUrl('/iclock/cdata?sn=ABC123').serialNumber, 'ABC123');
});

test('parses common ATTLOG layout with timestamp in one tab field', () => {
  const [punch] = parseAttlogBody('125\t2026-08-23 08:01:30\t0\t1\tWC1\textra');
  assert.equal(punch.parseValid, true);
  assert.equal(punch.deviceUserId, '125');
  assert.equal(punch.deviceEventTime, '2026-08-23 08:01:30');
  assert.equal(punch.rawStatus, '0');
  assert.equal(punch.rawVerify, '1');
  assert.equal(punch.workCode, 'WC1');
  assert.deepEqual(punch.extraFields, ['extra']);
  assert.equal('eventType' in punch, false);
});

test('also tolerates split date/time ATTLOG layout', () => {
  const [punch] = parseAttlogBody('125\t2026-08-23\t08:01:30\t0\t1');
  assert.equal(punch.deviceEventTime, '2026-08-23 08:01:30');
  assert.equal(punch.rawStatus, '0');
  assert.equal(punch.rawVerify, '1');
});

test('preserves malformed ATTLOG lines as invalid observations', () => {
  const [punch] = parseAttlogBody('unexpected-wire-layout');
  assert.equal(punch.parseValid, false);
  assert.equal(punch.rawLine, 'unexpected-wire-layout');
});

test('recognizes common biometric-template payload tables', () => {
  assert.equal(looksLikeBiometricTemplateTable('BIODATA'), true);
  assert.equal(looksLikeBiometricTemplateTable('FP'), true);
  assert.equal(looksLikeBiometricTemplateTable('FACE'), true);
  assert.equal(looksLikeBiometricTemplateTable('ATTLOG'), false);
});

import { observeDeviceOptionsBody } from '../src/infrastructure/vendors/zkteco/device-options.js';

test('observes textual device OPTIONS as sanitized properties without raw body', () => {
  const observed = observeDeviceOptionsBody('~SerialNumber=AJE1261900133,PushVersion=2.4.1,FirmwareVersion=TEST-1');
  assert.equal(observed.fields.SerialNumber, 'AJE1261900133');
  assert.equal(observed.fields.PushVersion, '2.4.1');
  assert.equal(observed.fields.FirmwareVersion, 'TEST-1');
  assert.equal(typeof observed.bodySha256, 'string');
  assert.equal(observed.bodySha256.length, 64);
  assert.equal('rawBody' in observed, false);
  assert.equal('body' in observed, false);
});

test('redacts secret and biometric-content-like device option values', () => {
  const observed = observeDeviceOptionsBody('CommKey=12345,Password=abc,FPVersion=10,FPData=VERY_SECRET_TEMPLATE');
  assert.equal(observed.fields.CommKey, '[REDACTED]');
  assert.equal(observed.fields.Password, '[REDACTED]');
  assert.equal(observed.fields.FPVersion, '10');
  assert.equal(observed.fields.FPData, '[REDACTED]');
});

test('omits abnormally long option values', () => {
  const observed = observeDeviceOptionsBody(`FirmwareVersion=${'x'.repeat(300)}`);
  assert.equal(observed.fields.FirmwareVersion, '[OMITTED:300_CHARS]');
});

import { observeOperlogBody, observeOperlogLine } from '../src/infrastructure/vendors/zkteco/operlog-observer.js';

test('observes OPERLOG USER while redacting password and card values', () => {
  const observed = observeOperlogBody('USER PIN=900001\tName=TEST USER\tPri=0\tPasswd=supersecret\tCard=123456\tGrp=1\tTZ=0000000100000000');
  assert.equal(observed.safeToAcknowledge, true);
  assert.equal(observed.recordCount, 1);
  assert.equal(observed.records[0].fields.PIN, '900001');
  assert.equal(observed.records[0].fields.Name, 'TEST USER');
  assert.equal(observed.records[0].fields.Passwd, '[REDACTED]');
  assert.equal(observed.records[0].fields.Card, '[REDACTED]');
  assert.equal(JSON.stringify(observed).includes('supersecret'), false);
  assert.equal(JSON.stringify(observed).includes('123456'), false);
});

test('observes fingerprint OPERLOG metadata without retaining template content or raw hash', () => {
  const template = 'VERY_SECRET_FP_TEMPLATE_DATA==';
  const observed = observeOperlogBody(`FP PIN=900001\tFID=1\tSize=${template.length}\tValid=1\tTMP=${template}`);
  const record = observed.records[0];
  assert.equal(observed.safeToAcknowledge, true);
  assert.equal(record.kind, 'biometric_template_metadata');
  assert.equal(record.fields.PIN, '900001');
  assert.equal(record.fields.FID, '1');
  assert.equal(record.templatePresent, true);
  assert.equal(record.templateDiscarded, true);
  assert.equal(record.templateCharacters, template.length);
  assert.equal(JSON.stringify(observed).includes(template), false);
  assert.equal('bodySha256' in observed, false);
});

test('observes mixed USER and FP OPERLOG batch safely', () => {
  const body = [
    'USER PIN=900001\tName=TEST\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=',
    'FP PIN=900001\tFID=1\tSize=12\tValid=1\tTMP=SECRET123456'
  ].join('\n');
  const observed = observeOperlogBody(body);
  assert.equal(observed.recordCount, 2);
  assert.equal(observed.recognizedCount, 2);
  assert.equal(observed.unrecognizedCount, 0);
  assert.equal(observed.tagCounts.USER, 1);
  assert.equal(observed.tagCounts.FP, 1);
  assert.equal(observed.safeToAcknowledge, true);
  assert.equal(JSON.stringify(observed).includes('SECRET123456'), false);
});

test('does not acknowledge an unknown OPERLOG record shape', () => {
  const observed = observeOperlogLine('SOMETHING_PRIVATE abc def ghi');
  assert.equal(observed.recognized, false);
  assert.equal(observed.record.kind, 'unknown');
  assert.equal('rawLine' in observed.record, false);
  assert.equal(observeOperlogBody('SOMETHING_PRIVATE abc def ghi').safeToAcknowledge, false);
});
