const READ_METHODS = ['getDashboard', 'pageDevices', 'pagePeople', 'pageFinalEvents'];

// A read-model adapter only: it does not own a pool, load configuration, or expose writes.
// The caller must explicitly supply the existing biometric read store.
export function createReadOnlyPortalService({ readStore } = {}) {
  if (!readStore || READ_METHODS.some(method => typeof readStore[method] !== 'function')) {
    throw new TypeError('A biometric read store with dashboard and paged read methods is required');
  }

  return Object.freeze({
    async overview() {
      const dashboard = await readStore.getDashboard();
      return {
        mode: 'database-readonly',
        counts: {
          devices: sourceInteger(dashboard?.devices?.total, 0, Number.MAX_SAFE_INTEGER, 'devices.total'),
          people: sourceInteger(dashboard?.people?.total, 0, Number.MAX_SAFE_INTEGER, 'people.total'),
          events: sourceInteger(dashboard?.finalEvents?.total, 0, Number.MAX_SAFE_INTEGER, 'finalEvents.total'),
        },
        // Configuration and stored device status do not establish a live connection or delivery.
        deviceConnection: 'unknown',
        outboundDelivery: 'unknown',
      };
    },
    async listDevices(filters = {}) {
      const query = readFilters(filters);
      return projectPage(await readStore.pageDevices(query), query, projectDevice);
    },
    async listPeople(filters = {}) {
      const query = readFilters(filters);
      return projectPage(await readStore.pagePeople(query), query, projectPerson);
    },
    async listEvents(filters = {}) {
      const query = readFilters(filters);
      return projectPage(await readStore.pageFinalEvents(query), query, projectEvent);
    },
  });
}

function projectDevice(row) {
  sourceObject(row, 'device');
  return {
    id: sourceId(row.id, 'device.id'),
    name: sourceText(row.display_name, 'device.display_name'),
    serialNumber: sourceText(row.serial_number, 'device.serial_number', true),
    model: sourceText(row.model, 'device.model'),
    status: 'unknown',
    administrativeStatus: sourceEnum(row.status, ['active', 'inactive'], 'device.status'),
    lastSeenAt: utcTime(row.last_seen_at, 'device.last_seen_at', true),
  };
}

function projectPerson(row) {
  sourceObject(row, 'person');
  return {
    id: sourceId(row.id, 'person.id'),
    personCode: sourceText(row.person_code, 'person.person_code', true),
    displayName: sourceText(row.display_name, 'person.display_name'),
    status: sourceEnum(row.status, ['active', 'inactive'], 'person.status'),
  };
}

function projectEvent(row) {
  sourceObject(row, 'event');
  const uuid = row.final_event_uuid;
  if (typeof uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw invalidSource('event.final_event_uuid');
  }
  return {
    id: uuid,
    personCode: sourceText(row.person_code, 'event.person_code', true),
    personName: sourceText(row.person_name, 'event.person_name'),
    eventType: sourceEnum(row.event_type,
      ['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out'], 'event.event_type'),
    eventTimeUtc: utcTime(row.event_time_utc, 'event.event_time_utc'),
    verificationMethod: sourceText(row.verification_method, 'event.verification_method'),
    deviceName: sourceText(row.device_display_name, 'event.device_display_name'),
  };
}

function readFilters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw invalidInput('Filters must be an object');
  let search = '';
  if (filters.search !== undefined) {
    if (typeof filters.search !== 'string') throw invalidInput('search must be a string');
    search = filters.search.trim();
    if (search.length > 100) throw invalidInput('search must be at most 100 characters');
  }
  return {
    page: inputInteger(filters.page, 1, 1_000_000, 'page'),
    limit: inputInteger(filters.limit, 20, 100, 'limit'),
    search,
  };
}

function inputInteger(value, fallback, maximum, field) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value))) {
    throw invalidInput(`${field} must be a complete positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw invalidInput(`${field} must be between 1 and ${maximum}`);
  }
  return number;
}

function projectPage(result, query, project) {
  sourceObject(result, 'page result');
  sourceObject(result.page, 'page');
  if (!Array.isArray(result.items)) throw invalidSource('items');
  const number = sourceInteger(result.page.number, 1, 1_000_000, 'page.number');
  const limit = sourceInteger(result.page.limit, 1, 100, 'page.limit');
  const total = sourceInteger(result.page.total, 0, Number.MAX_SAFE_INTEGER, 'page.total');
  const totalPages = sourceInteger(result.page.totalPages, 1, Number.MAX_SAFE_INTEGER, 'page.totalPages');
  if (number !== query.page || limit !== query.limit || totalPages !== Math.max(1, Math.ceil(total / limit)) ||
      result.items.length > limit || result.items.length > total) throw invalidSource('page metadata');
  return {
    items: result.items.map(project),
    page: { number, limit, total, totalPages },
  };
}

function sourceObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSource(field);
}

function sourceInteger(value, minimum, maximum, field) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value))) throw invalidSource(field);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw invalidSource(field);
  return number;
}

function sourceId(value, field) {
  if (typeof value === 'string' && /^[0-9]+$/.test(value) && /[1-9]/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'bigint' && value > 0n) return String(value);
  throw invalidSource(field);
}

function sourceText(value, field, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || (required && value.trim() === '')) throw invalidSource(field);
  return value;
}

function sourceEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw invalidSource(field);
  return value;
}

function utcTime(value, field, optional = false) {
  if (value == null && optional) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()) || value.getUTCFullYear() < 1 || value.getUTCFullYear() > 9999) {
      throw invalidSource(field);
    }
    return value.toISOString();
  }
  if (typeof value !== 'string') throw invalidSource(field);
  // MySQL dateStrings returns UTC DATETIME without a zone. Only the UTC-designated
  // read fields reach this function; never ask Date.parse to infer the host's zone.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z| (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)$/.exec(value);
  if (!match) throw invalidSource(field);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hourText = match[4] ?? match[8], minuteText = match[5] ?? match[9], secondText = match[6] ?? match[10];
  const fraction = match[7] ?? match[11] ?? '';
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] ||
      Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) throw invalidSource(field);
  // Preserve the supplied precision from DATETIME(6), without rounding or adding fractions.
  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${fraction ? `.${fraction}` : ''}Z`;
}

function invalidInput(message) {
  return Object.assign(new TypeError(message), { code: 'INVALID_INPUT', status: 400 });
}

function invalidSource(field) {
  return Object.assign(new TypeError(`Biometric read model has an invalid ${field}`), { code: 'READ_MODEL_INVALID', status: 500 });
}
