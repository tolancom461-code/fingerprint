import crypto from 'node:crypto';
import { createDeviceIdentity } from '../../../domain/device-identity.js';
import { normalizeZktecoAttendance } from './attlog-normalization.js';

const EVENT_FAMILY = 'attendance_punch';
const VENDOR_EVENT_TYPE = 'ATTLOG';
const DEDUPE_STRATEGY = 'zkteco-attlog-v1';
const DEDUPE_VERSION = '1';
const MAX_SOURCE_BYTES = 4096;
const MAX_FIELDS = 32;
const MAX_CORE_FIELD_LENGTH = 128;
const MAX_EXTRA_FIELDS = 16;
const SAFE_EXTRA_FIELD = /^-?\d{1,20}$/;

export function createZktecoAttlogObservations({ device, parsedLines, parserVersion }) {
  const identity = createDeviceIdentity(device);
  const lines = Array.isArray(parsedLines) ? parsedLines : [];
  return lines.map((parsed) => createObservation(identity, parsed, parserVersion));
}

function createObservation(identity, parsed, parserVersion) {
  const rawLine = String(parsed?.rawLine ?? '');
  const wireHash = sha256(`${identity.vendor}\n${identity.serialNumber}\n${rawLine}`);
  const sourceBytes = Buffer.byteLength(rawLine, 'utf8');
  const sourceFieldCount = Array.isArray(parsed?.rawFields) ? parsed.rawFields.length : 0;

  if (!parsed?.parseValid) {
    return Object.freeze({
      eventFamily: EVENT_FAMILY,
      vendorEventType: VENDOR_EVENT_TYPE,
      dedupeKey: sha256(`${identity.vendor}|${identity.serialNumber}|UNPARSED|${wireHash}`),
      dedupeStrategy: DEDUPE_STRATEGY,
      dedupeVersion: DEDUPE_VERSION,
      wireHash,
      parserVersion,
      parseValid: false,
      safeToAcknowledge: false,
      unsafeReason: 'unrecognized_attlog_shape',
      sourceBytes,
      sourceFieldCount,
      canonicalPayload: null
    });
  }

  const safety = validateSafeAttendanceFields(parsed, sourceBytes, sourceFieldCount);
  const dedupeKey = sha256([
    identity.vendor,
    identity.serialNumber,
    parsed.deviceUserId ?? '',
    parsed.deviceEventTime ?? '',
    parsed.rawStatus ?? '',
    parsed.rawVerify ?? ''
  ].join('|'));
  const normalized = normalizeZktecoAttendance({
    serialNumber: identity.serialNumber,
    rawStatus: parsed.rawStatus,
    rawVerify: parsed.rawVerify
  });

  return Object.freeze({
    eventFamily: EVENT_FAMILY,
    vendorEventType: VENDOR_EVENT_TYPE,
    dedupeKey,
    dedupeStrategy: DEDUPE_STRATEGY,
    dedupeVersion: DEDUPE_VERSION,
    wireHash,
    parserVersion,
    parseValid: true,
    safeToAcknowledge: safety.safe,
    unsafeReason: safety.reason,
    sourceBytes,
    sourceFieldCount,
    canonicalPayload: safety.safe ? Object.freeze({
      deviceUserId: parsed.deviceUserId,
      deviceEventTime: parsed.deviceEventTime,
      rawStatus: parsed.rawStatus ?? null,
      punchState: normalized.punchState,
      rawVerify: parsed.rawVerify ?? null,
      verificationMethod: normalized.verificationMethod,
      normalizationProfile: normalized.profileId,
      workCode: parsed.workCode ?? null,
      delimiter: parsed.delimiter ?? 'unknown',
      extraFields: Object.freeze([...(parsed.extraFields ?? [])])
    }) : null
  });
}

function validateSafeAttendanceFields(parsed, sourceBytes, sourceFieldCount) {
  if (sourceBytes <= 0 || sourceBytes > MAX_SOURCE_BYTES) return unsafe('attlog_line_size_out_of_bounds');
  if (sourceFieldCount <= 0 || sourceFieldCount > MAX_FIELDS) return unsafe('attlog_field_count_out_of_bounds');
  if (!safeCore(parsed.deviceUserId) || !safeCore(parsed.rawStatus) || !safeCore(parsed.rawVerify)) {
    return unsafe('attlog_core_field_out_of_bounds');
  }
  if (parsed.workCode != null && !safeCore(parsed.workCode)) return unsafe('attlog_work_code_out_of_bounds');

  const extraFields = Array.isArray(parsed.extraFields) ? parsed.extraFields : [];
  if (extraFields.length > MAX_EXTRA_FIELDS) return unsafe('attlog_extra_field_count_out_of_bounds');
  if (extraFields.some((value) => !SAFE_EXTRA_FIELD.test(String(value)))) {
    return unsafe('attlog_extra_field_not_safely_classified');
  }

  return { safe: true, reason: null };
}

function safeCore(value) {
  if (value == null) return false;
  const text = String(value);
  return text.length > 0 && text.length <= MAX_CORE_FIELD_LENGTH && !/[\r\n\0]/.test(text);
}

function unsafe(reason) {
  return { safe: false, reason };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
