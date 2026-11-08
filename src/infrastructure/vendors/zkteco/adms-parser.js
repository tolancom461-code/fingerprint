const FULL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY = /^\d{2}:\d{2}:\d{2}$/;

export function parseAdmsRequestUrl(url) {
  const parsedUrl = new URL(url, 'http://biometric.local');
  const query = Object.fromEntries(parsedUrl.searchParams.entries());
  return {
    pathname: parsedUrl.pathname,
    serialNumber: getQueryCaseInsensitive(parsedUrl.searchParams, 'SN').trim(),
    table: getQueryCaseInsensitive(parsedUrl.searchParams, 'table').trim().toUpperCase(),
    query
  };
}

function getQueryCaseInsensitive(searchParams, wanted) {
  const target = wanted.toLowerCase();
  for (const [key, value] of searchParams.entries()) {
    if (key.toLowerCase() === target) return value || '';
  }
  return '';
}

export function parseAttlogBody(body) {
  return String(body ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseAttlogLine);
}

export function parseAttlogLine(rawLine) {
  const normalized = String(rawLine ?? '').replace(/^\uFEFF/, '').trim();
  if (!normalized) return emptyParsed(rawLine);

  // Most TA PUSH devices use tabs and put the entire local timestamp in field 2:
  // PIN<TAB>YYYY-MM-DD HH:mm:ss<TAB>Status<TAB>Verify<TAB>WorkCode...
  // We also tolerate a split date/time layout and comma-separated middleware exports.
  let delimiter = 'whitespace';
  let fields;

  if (normalized.includes('\t')) {
    delimiter = 'tab';
    fields = normalized.split('\t').map((value) => value.trim());
  } else if (normalized.includes(',')) {
    delimiter = 'comma';
    fields = normalized.split(',').map((value) => value.trim());
  } else {
    fields = normalized.split(/\s+/).map((value) => value.trim());
  }

  const deviceUserId = fields[0] || null;
  let deviceEventTime = null;
  let statusIndex = 2;

  if (FULL_TIMESTAMP.test(fields[1] || '')) {
    deviceEventTime = fields[1].replace('T', ' ');
    statusIndex = 2;
  } else if (DATE_ONLY.test(fields[1] || '') && TIME_ONLY.test(fields[2] || '')) {
    deviceEventTime = `${fields[1]} ${fields[2]}`;
    statusIndex = 3;
  } else if (delimiter === 'whitespace' && DATE_ONLY.test(fields[1] || '') && TIME_ONLY.test(fields[2] || '')) {
    deviceEventTime = `${fields[1]} ${fields[2]}`;
    statusIndex = 3;
  }

  const rawStatus = fields[statusIndex] ?? null;
  const rawVerify = fields[statusIndex + 1] ?? null;
  const workCode = fields[statusIndex + 2] ?? null;
  const extraFields = fields.slice(statusIndex + 3);
  const parseValid = Boolean(deviceUserId && deviceEventTime);

  return {
    rawLine: normalized,
    rawFields: fields,
    delimiter,
    parseValid,
    deviceUserId,
    deviceEventTime,
    rawStatus,
    rawVerify,
    workCode,
    extraFields
  };
}

function emptyParsed(rawLine) {
  return {
    rawLine: String(rawLine ?? ''),
    rawFields: [],
    delimiter: 'unknown',
    parseValid: false,
    deviceUserId: null,
    deviceEventTime: null,
    rawStatus: null,
    rawVerify: null,
    workCode: null,
    extraFields: []
  };
}

export function looksLikeBiometricTemplateTable(table) {
  const value = String(table || '').trim().toUpperCase();
  return [
    'BIODATA', 'BIOPHOTO', 'FP', 'FINGER', 'FINGERPRINT', 'TEMPLATE',
    'FACE', 'FACEINFO', 'USERPIC', 'FVEIN', 'VEIN', 'PALM', 'PALMVEIN'
  ].includes(value);
}
