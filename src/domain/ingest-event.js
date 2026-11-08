import { createDeviceIdentity } from './device-identity.js';
import { createIngestStorageKey, STORAGE_IDENTITY_VERSION } from './storage-identity.js';

export function createIngestEvent({ device, observation, receivedAt, remoteAddress = null, captureId = null, captureIndex = null }) {
  const identity = createDeviceIdentity(device);

  if (!observation?.dedupeKey) throw new Error('observation.dedupeKey is required');
  if (!observation?.dedupeStrategy) throw new Error('observation.dedupeStrategy is required');
  if (!observation?.dedupeVersion) throw new Error('observation.dedupeVersion is required');
  if (!observation?.wireHash) throw new Error('observation.wireHash is required');

  const ingestKey = createIngestStorageKey({
    vendor: identity.vendor,
    serialNumber: identity.serialNumber,
    dedupeStrategy: observation.dedupeStrategy,
    dedupeVersion: observation.dedupeVersion,
    dedupeKey: observation.dedupeKey
  });

  return Object.freeze({
    ingestKey,
    storageIdentityVersion: STORAGE_IDENTITY_VERSION,
    dedupeKey: observation.dedupeKey,
    dedupeStrategy: observation.dedupeStrategy,
    dedupeVersion: observation.dedupeVersion,
    wireHash: observation.wireHash,
    vendor: identity.vendor,
    serialNumber: identity.serialNumber,
    deviceKey: identity.key,
    eventFamily: observation.eventFamily || 'unknown',
    vendorEventType: observation.vendorEventType || 'unknown',
    vendorEventId: observation.vendorEventId || null,
    adapterVersion: observation.adapterVersion || null,
    parserVersion: observation.parserVersion || 'unknown',
    parseValid: Boolean(observation.parseValid),
    safeToAcknowledge: Boolean(observation.safeToAcknowledge),
    unsafeReason: observation.unsafeReason || null,
    sourceBytes: Number.isInteger(observation.sourceBytes) ? observation.sourceBytes : null,
    sourceFieldCount: Number.isInteger(observation.sourceFieldCount) ? observation.sourceFieldCount : null,
    captureId,
    captureIndex: Number.isInteger(captureIndex) ? captureIndex : null,
    canonicalPayload: observation.canonicalPayload ? freezePayload(observation.canonicalPayload) : null,
    remoteAddress,
    receivedAt
  });
}

function freezePayload(payload) {
  const copy = { ...payload };
  if (Array.isArray(copy.extraFields)) copy.extraFields = Object.freeze([...copy.extraFields]);
  return Object.freeze(copy);
}
