import { localDateTimeToUtcSql } from './timezone.js';

const ACCEPTING_MODES = new Set(['test', 'live']);

export function evaluateDeviceRequestPolicy(device) {
  const status = normalize(device?.status);
  const mode = normalize(device?.mode);

  if (status !== 'active') {
    return Object.freeze({ allowed: false, reason: `status:${status || 'unknown'}` });
  }
  if (!ACCEPTING_MODES.has(mode)) {
    return Object.freeze({ allowed: false, reason: `mode:${mode || 'unknown'}` });
  }
  return Object.freeze({ allowed: true, reason: null });
}

export function evaluateDeviceEventPolicy(device, eventAt) {
  const request = evaluateDeviceRequestPolicy(device);
  if (!request.allowed) {
    return Object.freeze({ allowed: false, canonicalEligible: false, reason: request.reason });
  }

  const rawCutoff = device?.accept_events_from ?? device?.acceptEventsFrom;
  if (rawCutoff == null || rawCutoff === '') {
    return Object.freeze({ allowed: true, canonicalEligible: true, reason: null });
  }

  // accept_events_from is stored in TiDB as a UTC DATETIME(6). Device ATTLOG
  // timestamps are local wall-clock values, so convert the event to UTC using
  // the device's configured IANA timezone before comparing them.
  const cutoffUtc = normalizeSqlDateTime(rawCutoff);
  if (!cutoffUtc) {
    return Object.freeze({ allowed: true, canonicalEligible: false, reason: 'invalid_accept_events_from' });
  }

  const eventUtc = localDateTimeToUtcSql(eventAt, device?.timezone);
  if (!eventUtc) {
    return Object.freeze({ allowed: true, canonicalEligible: false, reason: 'invalid_event_time_for_accept_events_from' });
  }

  if (eventUtc < cutoffUtc) {
    return Object.freeze({ allowed: true, canonicalEligible: false, reason: 'before_accept_events_from' });
  }

  return Object.freeze({ allowed: true, canonicalEligible: true, reason: null });
}

export function normalizeSqlDateTime(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction = ''] = match;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${fraction.padEnd(6, '0')}`;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}
