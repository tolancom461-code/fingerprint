import { createHash } from 'node:crypto';

const MAX_FIELDS = 200;
const MAX_VALUE_CHARS = 256;

const SECRET_KEY = /(?:password|passwd|pwd|secret|token|authorization|api[_-]?key|comm(?:unication)?[_-]?key)/i;
const BIOMETRIC_CONTENT_KEY = /(?:template|biodata|biometricdata|finger(?:print)?data|fpdata|face(?:data|template|photo|image)|userpic|photo|picture|image|veindata|palmdata)/i;

/**
 * Parse the textual ZKTeco table=OPTIONS payload without persisting the raw body.
 * The observer keeps only a SHA-256 fingerprint, byte count and short sanitized
 * key/value properties. Long or sensitive values are deliberately omitted.
 */
export function observeDeviceOptionsBody(body) {
  const raw = String(body ?? '').replace(/^\uFEFF/, '');
  const bytes = Buffer.byteLength(raw, 'utf8');
  const bodySha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
  const fields = {};
  let parsedFieldCount = 0;
  let unparsedTokenCount = 0;
  let truncatedFieldCount = 0;

  const tokens = raw
    .split(/[\r\n\t,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    if (parsedFieldCount >= MAX_FIELDS) {
      truncatedFieldCount += 1;
      continue;
    }

    const equalsAt = token.indexOf('=');
    if (equalsAt <= 0) {
      unparsedTokenCount += 1;
      continue;
    }

    const key = normalizeKey(token.slice(0, equalsAt));
    if (!key) {
      unparsedTokenCount += 1;
      continue;
    }

    const value = sanitizeOptionValue(key, token.slice(equalsAt + 1));
    addField(fields, key, value);
    parsedFieldCount += 1;
  }

  return Object.freeze({
    bytes,
    bodySha256,
    parsedFieldCount,
    unparsedTokenCount,
    truncatedFieldCount,
    fields: Object.freeze(fields)
  });
}

function normalizeKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/^~+/, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 128);
}

function sanitizeOptionValue(key, value) {
  if (SECRET_KEY.test(key) || BIOMETRIC_CONTENT_KEY.test(key)) return '[REDACTED]';

  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim();

  if (cleaned.length > MAX_VALUE_CHARS) return `[OMITTED:${cleaned.length}_CHARS]`;
  return cleaned;
}

function addField(fields, key, value) {
  if (!(key in fields)) {
    fields[key] = value;
    return;
  }
  if (Array.isArray(fields[key])) {
    fields[key].push(value);
    return;
  }
  fields[key] = [fields[key], value];
}


export function toZktecoDeviceMetadata(fields = {}) {
  const lookup = caseInsensitiveLookup(fields);
  const capabilities = compactObject({
    pushVersion: lookup('PushVersion'),
    maxAttLogCount: lookup('MaxAttLogCount'),
    maxUserCount: lookup('MaxUserCount'),
    fingerEnabled: lookup('FingerFunOn'),
    fingerVersion: lookup('FPVersion'),
    maxFingerCount: lookup('MaxFingerCount'),
    faceEnabled: lookup('FaceFunOn'),
    faceVersion: lookup('FaceVersion'),
    palmEnabled: lookup('PvFunOn'),
    palmVersion: lookup('PvVersion'),
    maxPalmCount: lookup('MaxPvCount'),
    qrSupported: lookup('IsSupportQRcode')
  });

  return {
    displayName: lookup('DeviceName'),
    manufacturer: lookup('OEMVendor'),
    model: lookup('DeviceName'),
    protocol: 'PUSH',
    adapterType: 'zkteco-adms',
    firmwareVersion: lookup('FWVersion'),
    platform: lookup('Platform'),
    oemVendor: lookup('OEMVendor'),
    safeCapabilities: Object.keys(capabilities).length > 0 ? capabilities : null
  };
}

function caseInsensitiveLookup(fields) {
  const entries = new Map(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));
  return (key) => safeObservedValue(entries.get(String(key).toLowerCase()));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null && item !== ''));
}

function safeObservedValue(value) {
  if (value == null || Array.isArray(value)) return null;
  const text = String(value).trim();
  if (!text || text === '[REDACTED]' || text.startsWith('[OMITTED:')) return null;
  return text;
}
