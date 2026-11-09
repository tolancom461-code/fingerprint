const MAX_PEOPLE = 1000;
const SEARCH_LIMIT = 120;

// This service deliberately has no persistence, device, environment or network dependencies.
// Each factory call owns a new collection; all identifiers and sample rows are synthetic.
export function createDemoPortalService() {
  const devices = [
    { id: 'demo-device-001', name: 'جهاز تجريبي 1', serialNumber: 'DEMO-DEVICE-001', model: 'Demo simulator', status: 'not_connected', lastSeenAt: null },
    { id: 'demo-device-002', name: 'جهاز تجريبي 2', serialNumber: 'DEMO-DEVICE-002', model: 'Demo simulator', status: 'not_connected', lastSeenAt: null },
  ];
  const people = [
    { id: 'demo-person-001', personCode: 'DEMO-001', displayName: 'شخص تجريبي 1', status: 'active' },
    { id: 'demo-person-002', personCode: 'DEMO-002', displayName: 'شخص تجريبي 2', status: 'active' },
    { id: 'demo-person-003', personCode: 'DEMO-003', displayName: 'شخص تجريبي 3', status: 'active' },
  ];
  const events = people.flatMap((person, index) => [
    {
      id: `demo-event-${String(index * 2 + 1).padStart(3, '0')}`,
      personCode: person.personCode,
      personName: person.displayName,
      eventType: 'check_in',
      eventTimeUtc: `2026-01-15T0${6 + index}:00:00Z`,
      verificationMethod: 'demo',
      deviceName: devices[index % devices.length].name,
    },
    {
      id: `demo-event-${String(index * 2 + 2).padStart(3, '0')}`,
      personCode: person.personCode,
      personName: person.displayName,
      eventType: 'check_out',
      eventTimeUtc: `2026-01-15T${14 + index}:00:00Z`,
      verificationMethod: 'demo',
      deviceName: devices[index % devices.length].name,
    },
  ]);

  return {
    overview() {
      return {
        mode: 'demo',
        counts: { devices: devices.length, people: people.length, events: events.length },
        deviceConnection: 'not_connected',
        outboundDelivery: 'disabled',
      };
    },
    listDevices(filters = {}) {
      return list(devices, filters, ['name', 'serialNumber', 'model', 'status']);
    },
    listPeople(filters = {}) {
      return list(people, filters, ['personCode', 'displayName', 'status']);
    },
    listEvents(filters = {}) {
      return list(events, filters, ['personCode', 'personName', 'eventType', 'eventTimeUtc', 'verificationMethod', 'deviceName']);
    },
    createPerson(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw invalid('Person must be an object');
      }
      const personCode = text(input.personCode, 'personCode', 65).toUpperCase();
      if (!/^DEMO-[A-Z0-9._-]{1,60}$/.test(personCode)) {
        throw invalid('personCode must start with DEMO- and contain only letters, digits, dot, underscore or hyphen');
      }
      const displayName = text(input.displayName, 'displayName', 120);
      if (people.some(person => person.personCode === personCode)) {
        throw coded('PERSON_CODE_CONFLICT', 'A demo person with this code already exists', 409);
      }
      if (people.length >= MAX_PEOPLE) {
        throw coded('DEMO_CAPACITY_REACHED', 'The demo supports at most 1000 people', 429);
      }
      const person = {
        id: `demo-person-${String(people.length + 1).padStart(3, '0')}`,
        personCode,
        displayName,
        status: 'active',
      };
      people.push(person);
      return { ...person };
    },
  };
}

function list(rows, filters, searchFields) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw invalid('Filters must be an object');
  }
  const number = positiveInteger(filters.page, 1, Number.MAX_SAFE_INTEGER, 'page');
  const limit = positiveInteger(filters.limit, 20, 100, 'limit');
  let search = '';
  if (filters.search !== undefined) {
    if (typeof filters.search !== 'string') throw invalid('search must be a string');
    search = filters.search.trim();
    if (search.length > SEARCH_LIMIT) throw invalid('search must be at most 120 characters');
    search = search.toLowerCase();
  }
  const matching = search
    ? rows.filter(row => searchFields.some(field => String(row[field]).toLowerCase().includes(search)))
    : rows;
  const start = (number - 1) * limit;
  return {
    items: (start >= matching.length ? [] : matching.slice(start, start + limit)).map(row => ({ ...row })),
    page: { number, limit, total: matching.length, totalPages: Math.max(1, Math.ceil(matching.length / limit)) },
  };
}

function positiveInteger(value, fallback, max, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value))) {
    throw invalid(`${label} must be a complete positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw invalid(`${label} must be an integer between 1 and ${max}`);
  }
  return number;
}

function text(value, label, max) {
  if (typeof value !== 'string') throw invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw invalid(`${label} must contain between 1 and ${max} characters`);
  return normalized;
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_INPUT';
  error.status = 400;
  return error;
}

function coded(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}
