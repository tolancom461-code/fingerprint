import { localDateTimeToUtcSql } from './timezone.js';
import { STORAGE_IDENTITY_VERSION } from './storage-identity.js';

const CORE_EVENT_KEY_STRATEGY = 'core-qualified-dedupe';

export function createCanonicalPunchFromIngest(ingest) {
  const payload = ingest?.canonicalPayload;
  if (!payload) return null;

  return Object.freeze({
    ingestKey: ingest.ingestKey,
    ingestEventId: ingest.ingestEventId ?? null,
    deviceId: ingest.deviceId ?? null,
    eventKey: ingest.ingestKey,
    eventKeyStrategy: CORE_EVENT_KEY_STRATEGY,
    eventKeyVersion: ingest.storageIdentityVersion ?? STORAGE_IDENTITY_VERSION,
    vendorDedupeKey: ingest.dedupeKey,
    vendorDedupeStrategy: ingest.dedupeStrategy,
    vendorDedupeVersion: ingest.dedupeVersion,
    // Compatibility only: v0.7 canonical files used the vendor key as eventKey.
    legacyEventKey: ingest.dedupeKey,
    wireHash: ingest.wireHash,
    parserVersion: ingest.parserVersion,
    vendor: ingest.vendor,
    serialNumber: ingest.serialNumber,
    deviceKey: ingest.deviceKey,
    parseValid: Boolean(ingest.parseValid),
    delimiter: payload.delimiter ?? 'unknown',
    deviceUserId: payload.deviceUserId ?? null,
    deviceEventTime: payload.deviceEventTime ?? null,
    deviceTimezone: ingest.deviceTimezone ?? null,
    deviceEventTimeUtc: localDateTimeToUtcSql(payload.deviceEventTime, ingest.deviceTimezone),
    rawStatus: payload.rawStatus ?? null,
    punchState: payload.punchState ?? null,
    rawVerify: payload.rawVerify ?? null,
    verificationMethod: payload.verificationMethod ?? null,
    workCode: payload.workCode ?? null,
    extraFields: Object.freeze([...(payload.extraFields ?? [])]),
    wireSourceBytes: ingest.sourceBytes ?? null,
    receivedAt: ingest.receivedAt
  });
}
