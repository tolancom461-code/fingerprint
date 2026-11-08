import crypto from 'node:crypto';

export const STORAGE_IDENTITY_VERSION = '1';

export function createIngestStorageKey({ vendor, serialNumber, dedupeStrategy, dedupeVersion, dedupeKey }) {
  const parts = [vendor, serialNumber, dedupeStrategy, dedupeVersion, dedupeKey].map(requiredText);
  return sha256(JSON.stringify(['biometric-ingest', STORAGE_IDENTITY_VERSION, ...parts]));
}

export function resolveIngestStorageKey(record) {
  try {
    return createIngestStorageKey(record ?? {});
  } catch {
    const fallback = String(record?.ingestKey ?? record?.dedupeKey ?? '').trim();
    if (!fallback) throw new Error('ingest storage identity cannot be resolved');
    return fallback;
  }
}

export function createLegacyScopedPunchKey({ vendor, serialNumber, eventKey }) {
  const vendorText = requiredText(vendor);
  const serialText = requiredText(serialNumber);
  const eventText = requiredText(eventKey);
  return sha256(JSON.stringify(['legacy-canonical-punch', vendorText, serialText, eventText]));
}

function requiredText(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('storage identity fields must be non-empty');
  return text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
