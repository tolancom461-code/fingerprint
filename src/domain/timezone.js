export function localDateTimeToUtcSql(localDateTime, timeZone) {
  const parsed = parseLocalDateTime(localDateTime);
  if (!parsed || !isValidTimeZone(timeZone)) return null;

  const localAsUtcMs = Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, parsed.second, parsed.millisecond);
  const firstOffset = offsetMillisecondsAt(localAsUtcMs, timeZone);
  if (firstOffset == null) return null;

  let utcMs = localAsUtcMs - firstOffset;
  const secondOffset = offsetMillisecondsAt(utcMs, timeZone);
  if (secondOffset == null) return null;
  if (secondOffset !== firstOffset) utcMs = localAsUtcMs - secondOffset;

  if (!sameLocalClock(utcMs, timeZone, parsed)) return null;

  const date = new Date(utcMs);
  const iso = date.toISOString();
  const base = iso.slice(0, 19).replace('T', ' ');
  return `${base}.${parsed.microseconds}`;
}

export function isValidTimeZone(timeZone) {
  const value = String(timeZone ?? '').trim();
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function parseLocalDateTime(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) return null;
  const fraction = (match[7] || '').padEnd(6, '0');
  const parsed = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]),
    microseconds: fraction, millisecond: Number(fraction.slice(0, 3))
  };
  const check = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, parsed.second, parsed.millisecond));
  if (check.getUTCFullYear() !== parsed.year || check.getUTCMonth() + 1 !== parsed.month || check.getUTCDate() !== parsed.day ||
      check.getUTCHours() !== parsed.hour || check.getUTCMinutes() !== parsed.minute || check.getUTCSeconds() !== parsed.second) return null;
  return parsed;
}

function offsetMillisecondsAt(epochMs, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    const zoneName = formatter.formatToParts(new Date(epochMs)).find((part) => part.type === 'timeZoneName')?.value;
    if (zoneName === 'GMT' || zoneName === 'UTC') return 0;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zoneName || '');
    if (!match) return null;
    const sign = match[1] === '+' ? 1 : -1;
    return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  } catch {
    return null;
  }
}

function sameLocalClock(epochMs, timeZone, expected) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return Number(parts.year) === expected.year && Number(parts.month) === expected.month && Number(parts.day) === expected.day &&
    Number(parts.hour) === expected.hour && Number(parts.minute) === expected.minute && Number(parts.second) === expected.second;
}
