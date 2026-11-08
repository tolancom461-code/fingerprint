import crypto from 'node:crypto';

const USER_SAFE_FIELDS = new Set([
  'PIN', 'Name', 'Pri', 'Grp', 'TZ', 'Verify', 'StartDatetime', 'EndDatetime'
]);
const USER_REDACT_FIELDS = new Set([
  'Passwd', 'Password', 'Card', 'ViceCard', 'UserPassword'
]);
const TEMPLATE_TAGS = new Set([
  'FP', 'FACE', 'FVEIN', 'VEIN', 'PALM', 'PALMVEIN', 'BIODATA', 'BIOPHOTO', 'USERPIC'
]);
const TEMPLATE_SAFE_FIELDS = new Set([
  'PIN', 'FID', 'No', 'Index', 'Size', 'Valid', 'Type', 'Format', 'Version', 'MajorVer', 'MinorVer'
]);
const TEMPLATE_SECRET_FIELDS = new Set([
  'TMP', 'Template', 'Data', 'Content', 'Photo', 'Image', 'BioData'
]);
const MAX_SAFE_VALUE_CHARS = 256;

/**
 * Safely observes an OPERLOG payload without persisting biometric templates,
 * passwords, card numbers, or raw unknown lines.
 */
export function observeOperlogBody(body) {
  const text = String(body ?? '').replace(/^\uFEFF/, '');
  const bytes = Buffer.byteLength(text, 'utf8');
  const records = [];
  const tagCounts = {};
  let recognizedCount = 0;
  let unrecognizedCount = 0;
  let discardedSensitiveValueCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const observed = observeOperlogLine(line);
    records.push(observed.record);
    tagCounts[observed.record.tag] = (tagCounts[observed.record.tag] || 0) + 1;
    if (observed.recognized) recognizedCount += 1;
    else unrecognizedCount += 1;
    discardedSensitiveValueCount += observed.discardedSensitiveValueCount;
  }

  const sanitizedCanonical = JSON.stringify(records);
  return {
    bytes,
    recordCount: records.length,
    recognizedCount,
    unrecognizedCount,
    discardedSensitiveValueCount,
    tagCounts,
    records,
    sanitizedSha256: crypto.createHash('sha256').update(sanitizedCanonical).digest('hex'),
    safeToAcknowledge: records.length > 0 && unrecognizedCount === 0
  };
}

export function observeOperlogLine(line) {
  const split = splitTagAndRemainder(line);
  const tag = split.tag;

  if (tag === 'USER') return observeUserRecord(split.remainder);
  if (TEMPLATE_TAGS.has(tag)) return observeTemplateRecord(tag, split.remainder);
  if (tag === 'OPLOG') return observeAdminOperationRecord(split.remainder);

  return {
    recognized: false,
    discardedSensitiveValueCount: 0,
    record: {
      tag: tag || 'UNKNOWN',
      kind: 'unknown',
      bytes: Buffer.byteLength(line, 'utf8')
    }
  };
}

function splitTagAndRemainder(line) {
  const match = String(line).match(/^([^\s\t]+)(?:[\s\t]+(.*))?$/s);
  if (!match) return { tag: 'UNKNOWN', remainder: '' };
  return { tag: String(match[1] || '').trim().toUpperCase(), remainder: String(match[2] || '') };
}

function observeUserRecord(remainder) {
  const fields = parseNamedFields(remainder);
  const safeFields = {};
  let discardedSensitiveValueCount = 0;

  for (const [key, value] of Object.entries(fields)) {
    if (USER_REDACT_FIELDS.has(key) || looksSensitiveFieldName(key)) {
      safeFields[key] = '[REDACTED]';
      discardedSensitiveValueCount += 1;
      continue;
    }
    if (USER_SAFE_FIELDS.has(key)) safeFields[key] = safeValue(value);
  }

  return {
    recognized: true,
    discardedSensitiveValueCount,
    record: {
      tag: 'USER',
      kind: 'device_user',
      fields: safeFields,
      sourceFieldCount: Object.keys(fields).length
    }
  };
}

function observeTemplateRecord(tag, remainder) {
  const fields = parseNamedFields(remainder);
  const safeFields = {};
  let discardedSensitiveValueCount = 0;
  let templatePresent = false;
  let templateCharacters = null;

  for (const [key, value] of Object.entries(fields)) {
    if (TEMPLATE_SECRET_FIELDS.has(key) || looksTemplateFieldName(key)) {
      templatePresent = templatePresent || String(value).length > 0;
      if (templateCharacters == null && String(value).length > 0) templateCharacters = String(value).length;
      discardedSensitiveValueCount += 1;
      continue;
    }
    if (TEMPLATE_SAFE_FIELDS.has(key)) safeFields[key] = safeValue(value);
  }

  return {
    recognized: true,
    discardedSensitiveValueCount,
    record: {
      tag,
      kind: 'biometric_template_metadata',
      fields: safeFields,
      templatePresent,
      templateCharacters,
      templateDiscarded: true,
      sourceFieldCount: Object.keys(fields).length
    }
  };
}

function observeAdminOperationRecord(remainder) {
  // OPLOG records are positional on many PUSH firmwares. Do not retain raw
  // operation objects until the exact firmware layout is validated.
  const tokens = String(remainder)
    .split(/\t+/)
    .map((value) => value.trim())
    .filter(Boolean);

  let eventTime = null;
  for (const token of tokens) {
    const match = token.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/);
    if (match) { eventTime = match[0].replace('T', ' '); break; }
  }

  return {
    recognized: true,
    discardedSensitiveValueCount: 0,
    record: {
      tag: 'OPLOG',
      kind: 'administrator_operation',
      fieldCount: tokens.length,
      eventTime
    }
  };
}

function parseNamedFields(remainder) {
  const output = {};
  const chunks = String(remainder).split(/\t+/);
  for (const chunk of chunks) {
    const text = chunk.trim();
    if (!text) continue;

    // Some older firmware/examples separate early fields with spaces instead
    // of tabs. Extract repeated Name=Value pairs while allowing spaces in a
    // value until the next FieldName= marker.
    const matches = [...text.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*)=([^]*?)(?=\s+[A-Za-z][A-Za-z0-9_]*=|$)/g)];
    if (matches.length > 0) {
      for (const match of matches) output[match[1]] = match[2].trim();
      continue;
    }

    const eq = text.indexOf('=');
    if (eq > 0) output[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return output;
}

function safeValue(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_SAFE_VALUE_CHARS) return text;
  return `[OMITTED:${text.length}_CHARS]`;
}

function looksSensitiveFieldName(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.includes('password') || normalized.includes('passwd') || normalized.endsWith('card') || normalized.includes('secret') || normalized.includes('commkey');
}

function looksTemplateFieldName(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['tmp', 'template', 'data', 'content', 'image', 'photo', 'biodata'].some((part) => normalized === part || normalized.endsWith(part));
}
