import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const T = BIOMETRIC_TABLES;
const EVENT_TYPES = new Set(['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out']);
const VERIFICATION_METHODS = new Set(['fingerprint', 'face', 'palm', 'card', 'password', 'unknown']);
const PERSON_STATUSES = new Set(['active', 'inactive']);
const ISSUE_STATUSES = new Set(['open', 'resolved']);
const MAPPING_STATES = new Set(['mapped', 'unmapped']);
const DEVICE_MODES = new Set(['test', 'live', 'maintenance']);
const DEVICE_STATUSES = new Set(['active', 'inactive']);

export class TiDbAdminReadStore {
  constructor(pool) { this.pool = pool; }

  async getDashboard() {
    const [[deviceRows], [peopleRows], [unmappedRows], [issueRows], [eventRows]] = await Promise.all([
      this.pool.execute(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = 'active'), 0) AS active,
                COALESCE(SUM(mode = 'test'), 0) AS test_mode
           FROM \`${T.devices}\``
      ),
      this.pool.execute(
        `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'active'), 0) AS active
           FROM \`${T.people}\``
      ),
      this.pool.execute(
        `SELECT COUNT(*) AS total
           FROM \`${T.deviceUsers}\` u
           LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id = u.id
          WHERE m.id IS NULL`
      ),
      this.pool.execute(
        `SELECT COUNT(*) AS total
           FROM \`${T.finalizationIssues}\`
          WHERE status = 'open'`
      ),
      this.pool.execute(
        `SELECT COUNT(*) AS total, MAX(finalized_at) AS latest_finalized_at
           FROM \`${T.finalEvents}\`
          WHERE status = 'final'`
      )
    ]);

    return {
      devices: numbers(deviceRows?.[0], ['total', 'active', 'test_mode']),
      people: numbers(peopleRows?.[0], ['total', 'active']),
      unmappedDeviceUsers: Number(unmappedRows?.[0]?.total ?? 0),
      openIssues: Number(issueRows?.[0]?.total ?? 0),
      finalEvents: {
        total: Number(eventRows?.[0]?.total ?? 0),
        latestFinalizedAt: eventRows?.[0]?.latest_finalized_at ?? null
      }
    };
  }

  // Compact overview reads retained for the home screen and mapping dialog.
  async listDevices({ limit = 100 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 500, 100);
    const [rows] = await this.pool.execute(
      `SELECT id, vendor, serial_number, display_name, manufacturer, model, mode, status,
              timezone, firmware_version, platform, last_seen_at, last_event_at, last_ip_address
         FROM \`${T.devices}\`
        ORDER BY status = 'active' DESC, last_seen_at DESC, id ASC
        LIMIT ${safeLimit}`
    );
    return rows ?? [];
  }

  async listPeople({ search = null, limit = 200 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 500, 200);
    const text = optionalSearch(search);
    const params = [];
    let where = '';
    if (text) {
      where = 'WHERE p.person_code LIKE ? OR p.display_name LIKE ?';
      const like = `%${text}%`;
      params.push(like, like);
    }
    const [rows] = await this.pool.execute(
      `SELECT p.id, p.person_code, p.display_name, p.status, p.notes,
              COUNT(m.id) AS mapped_device_users,
              MAX(m.updated_at) AS mapping_updated_at,
              p.created_at, p.updated_at
         FROM \`${T.people}\` p
         LEFT JOIN \`${T.personDeviceUsers}\` m ON m.person_id = p.id AND m.status = 'active'
         ${where}
        GROUP BY p.id, p.person_code, p.display_name, p.status, p.notes, p.created_at, p.updated_at
        ORDER BY p.status = 'active' DESC, p.display_name ASC, p.id DESC
        LIMIT ${safeLimit}`,
      params
    );
    return (rows ?? []).map((row) => ({ ...row, mapped_device_users: Number(row.mapped_device_users ?? 0) }));
  }

  async listUnmappedDeviceUsers({ limit = 200 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 500, 200);
    const [rows] = await this.pool.execute(
      `SELECT u.id, u.device_id, u.device_user_id, u.display_name, u.status,
              u.first_seen_at, u.last_seen_at,
              d.vendor, d.serial_number, d.display_name AS device_display_name,
              p.id AS suggested_person_id, p.person_code AS suggested_person_code,
              p.display_name AS suggested_person_name, p.status AS suggested_person_status
         FROM \`${T.deviceUsers}\` u
         JOIN \`${T.devices}\` d ON d.id = u.device_id
         LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id = u.id
         LEFT JOIN \`${T.people}\` p ON p.person_code = u.device_user_id
        WHERE m.id IS NULL
        ORDER BY u.last_seen_at DESC, u.id DESC
        LIMIT ${safeLimit}`
    );
    return rows ?? [];
  }

  async listOpenIssues({ limit = 200 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 500, 200);
    const [rows] = await this.pool.execute(
      `${issueSelect()}
        WHERE i.status = 'open'
        ORDER BY i.last_seen_at DESC, i.id DESC
        LIMIT ${safeLimit}`
    );
    return rows ?? [];
  }

  async listRecentFinalEvents({ limit = 100 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 500, 100);
    const [rows] = await this.pool.execute(
      `${eventSelect()}
        WHERE f.status = 'final'
        ORDER BY f.event_time_utc DESC, f.id DESC
        LIMIT ${safeLimit}`
    );
    return rows ?? [];
  }

  async pageFinalEvents(filters = {}) {
    const page = pageSpec(filters);
    const { clauses, params } = finalEventFilters(filters);
    const where = `WHERE ${['f.status = \'final\'', ...clauses].join(' AND ')}`;
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(
        `SELECT COUNT(*) AS total
           FROM \`${T.finalEvents}\` f
           LEFT JOIN \`${T.people}\` p ON p.id = f.person_id
           LEFT JOIN \`${T.devices}\` d ON d.id = f.device_id
         ${where}`,
        params
      ),
      this.pool.execute(
        `${eventSelect()}
         ${where}
         ORDER BY f.event_time_utc DESC, f.id DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
        params
      )
    ]);
    return paged(rows, countRows?.[0]?.total, page);
  }

  async exportFinalEvents(filters = {}, { limit = 10000 } = {}) {
    const safeLimit = boundedInteger(limit, 1, 10000, 10000);
    const { clauses, params } = finalEventFilters(filters);
    const where = `WHERE ${['f.status = \'final\'', ...clauses].join(' AND ')}`;
    const [rows] = await this.pool.execute(
      `${eventSelect()}
       ${where}
       ORDER BY f.event_time_utc DESC, f.id DESC
       LIMIT ${safeLimit}`,
      params
    );
    return rows ?? [];
  }

  async getFinalEventDetail(finalEventUuid) {
    const uuid = normalizeUuid(finalEventUuid);
    const [rows] = await this.pool.execute(
      `${eventSelect()}
        WHERE f.status = 'final' AND f.final_event_uuid = ?
        LIMIT 1`,
      [uuid]
    );
    return rows?.[0] ?? null;
  }

  async pagePeople(filters = {}) {
    const page = pageSpec(filters);
    const params = [];
    const clauses = [];
    const text = optionalSearch(filters.search);
    if (text) {
      const like = `%${text}%`;
      clauses.push('(p.person_code LIKE ? OR p.display_name LIKE ?)');
      params.push(like, like);
    }
    const status = optionalEnum(filters.status, PERSON_STATUSES, 'status');
    if (status) { clauses.push('p.status = ?'); params.push(status); }
    const mapping = optionalEnum(filters.mapping, MAPPING_STATES, 'mapping');
    if (mapping === 'mapped') clauses.push(`EXISTS (SELECT 1 FROM \`${T.personDeviceUsers}\` mx WHERE mx.person_id = p.id AND mx.status = 'active')`);
    if (mapping === 'unmapped') clauses.push(`NOT EXISTS (SELECT 1 FROM \`${T.personDeviceUsers}\` mx WHERE mx.person_id = p.id AND mx.status = 'active')`);
    const deviceId = optionalPositiveId(filters.deviceId, 'deviceId');
    if (deviceId) {
      clauses.push(`EXISTS (
        SELECT 1 FROM \`${T.personDeviceUsers}\` md
        JOIN \`${T.deviceUsers}\` du ON du.id = md.device_user_row_id
        WHERE md.person_id = p.id AND md.status = 'active' AND du.device_id = ?
      )`);
      params.push(deviceId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total FROM \`${T.people}\` p ${where}`, params),
      this.pool.execute(
        `SELECT p.id, p.person_code, p.display_name, p.status, p.notes,
                COUNT(m.id) AS mapped_device_users,
                MAX(m.updated_at) AS mapping_updated_at,
                p.created_at, p.updated_at
           FROM \`${T.people}\` p
           LEFT JOIN \`${T.personDeviceUsers}\` m ON m.person_id = p.id AND m.status = 'active'
           ${where}
          GROUP BY p.id, p.person_code, p.display_name, p.status, p.notes, p.created_at, p.updated_at
          ORDER BY p.status = 'active' DESC, p.display_name ASC, p.id DESC
          LIMIT ${page.limit} OFFSET ${page.offset}`,
        params
      )
    ]);
    return paged((rows ?? []).map((row) => ({ ...row, mapped_device_users: Number(row.mapped_device_users ?? 0) })), countRows?.[0]?.total, page);
  }

  async pageUnmappedDeviceUsers(filters = {}) {
    const page = pageSpec(filters);
    const params = [];
    const clauses = ['m.id IS NULL'];
    const text = optionalSearch(filters.search);
    if (text) {
      const like = `%${text}%`;
      clauses.push('(u.device_user_id LIKE ? OR u.display_name LIKE ? OR d.display_name LIKE ? OR d.serial_number LIKE ?)');
      params.push(like, like, like, like);
    }
    const deviceId = optionalPositiveId(filters.deviceId, 'deviceId');
    if (deviceId) { clauses.push('u.device_id = ?'); params.push(deviceId); }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const from = `FROM \`${T.deviceUsers}\` u
      JOIN \`${T.devices}\` d ON d.id = u.device_id
      LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id = u.id
      LEFT JOIN \`${T.people}\` p ON p.person_code = u.device_user_id`;
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total ${from} ${where}`, params),
      this.pool.execute(
        `SELECT u.id, u.device_id, u.device_user_id, u.display_name, u.status,
                u.first_seen_at, u.last_seen_at,
                d.vendor, d.serial_number, d.display_name AS device_display_name,
                p.id AS suggested_person_id, p.person_code AS suggested_person_code,
                p.display_name AS suggested_person_name, p.status AS suggested_person_status
           ${from}
           ${where}
          ORDER BY u.last_seen_at DESC, u.id DESC
          LIMIT ${page.limit} OFFSET ${page.offset}`,
        params
      )
    ]);
    return paged(rows, countRows?.[0]?.total, page);
  }

  async pageIssues(filters = {}) {
    const page = pageSpec(filters);
    const params = [];
    const clauses = [];
    const status = optionalEnum(filters.status, ISSUE_STATUSES, 'status');
    if (status) { clauses.push('i.status = ?'); params.push(status); }
    const issueType = optionalToken(filters.issueType, 'issueType');
    if (issueType) { clauses.push('i.issue_type = ?'); params.push(issueType); }
    const deviceId = optionalPositiveId(filters.deviceId, 'deviceId');
    if (deviceId) { clauses.push('p.device_id = ?'); params.push(deviceId); }
    const text = optionalSearch(filters.search);
    if (text) {
      const like = `%${text}%`;
      clauses.push('(p.device_user_id LIKE ? OR person.person_code LIKE ? OR person.display_name LIKE ? OR d.display_name LIKE ?)');
      params.push(like, like, like, like);
    }
    addDayRange(clauses, params, 'i.first_seen_at', filters.from, filters.to);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const joins = issueJoins();
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total ${joins} ${where}`, params),
      this.pool.execute(
        `${issueSelect()}
         ${where}
         ORDER BY i.last_seen_at DESC, i.id DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
        params
      )
    ]);
    return paged(rows, countRows?.[0]?.total, page);
  }

  async pageDevices(filters = {}) {
    const page = pageSpec(filters);
    const params = [];
    const clauses = [];
    const text = optionalSearch(filters.search);
    if (text) {
      const like = `%${text}%`;
      clauses.push('(d.display_name LIKE ? OR d.model LIKE ? OR d.serial_number LIKE ? OR d.vendor LIKE ?)');
      params.push(like, like, like, like);
    }
    const status = optionalEnum(filters.status, DEVICE_STATUSES, 'status');
    if (status) { clauses.push('d.status = ?'); params.push(status); }
    const mode = optionalEnum(filters.mode, DEVICE_MODES, 'mode');
    if (mode) { clauses.push('d.mode = ?'); params.push(mode); }
    const vendor = optionalToken(filters.vendor, 'vendor');
    if (vendor) { clauses.push('d.vendor = ?'); params.push(vendor); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [[countRows], [rows]] = await Promise.all([
      this.pool.execute(`SELECT COUNT(*) AS total FROM \`${T.devices}\` d ${where}`, params),
      this.pool.execute(
        `SELECT d.id, d.vendor, d.serial_number, d.display_name, d.manufacturer, d.model, d.mode, d.status,
                d.timezone, d.firmware_version, d.platform, d.last_seen_at, d.last_event_at, d.last_ip_address
           FROM \`${T.devices}\` d
           ${where}
          ORDER BY d.status = 'active' DESC, d.last_seen_at DESC, d.id ASC
          LIMIT ${page.limit} OFFSET ${page.offset}`,
        params
      )
    ]);
    return paged(rows, countRows?.[0]?.total, page);
  }

  async getOperationalReports({ from = null, to = null } = {}) {
    const range = normalizedDayRange(from, to);
    const healthParams = [];
    const punchRange = sqlRange('p.device_event_time_local', range, healthParams);
    const finalRange = sqlRange('f.event_time_local', range, healthParams);
    const issueRange = sqlRange('i.first_seen_at', range, healthParams);
    const [healthRows] = await this.pool.execute(
      `SELECT
        (SELECT COUNT(*) FROM \`${T.punches}\` p ${punchRange ? `WHERE ${punchRange}` : ''}) AS canonical_punches,
        (SELECT COUNT(*) FROM \`${T.finalEvents}\` f WHERE f.status = 'final'${finalRange ? ` AND ${finalRange}` : ''}) AS final_events,
        (SELECT COUNT(*) FROM \`${T.finalizationIssues}\` i ${issueRange ? `WHERE ${issueRange} AND (i.issue_type <> 'automatic_finalization_pending' OR i.status = 'open')` : "WHERE (i.issue_type <> 'automatic_finalization_pending' OR i.status = 'open')"}) AS issues_in_period,
        (SELECT COUNT(*) FROM \`${T.finalizationIssues}\` io WHERE io.status = 'open') AS open_issues_now,
        (SELECT COUNT(*) FROM \`${T.deviceUsers}\` u LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id = u.id WHERE m.id IS NULL) AS unmapped_now`,
      healthParams
    );

    const deviceParams = [];
    const deviceEventRange = sqlRange('f.event_time_local', range, deviceParams);
    const [deviceRows] = await this.pool.execute(
      `SELECT d.id, d.vendor, d.serial_number, d.display_name, d.model, d.mode, d.status,
              d.last_seen_at, d.last_event_at,
              (SELECT COUNT(*) FROM \`${T.finalEvents}\` f
                WHERE f.device_id = d.id AND f.status = 'final'${deviceEventRange ? ` AND ${deviceEventRange}` : ''}) AS final_events_in_period,
              (SELECT COUNT(*) FROM \`${T.finalizationIssues}\` i
                JOIN \`${T.punches}\` p ON p.id = i.source_punch_id
                WHERE p.device_id = d.id AND i.status = 'open') AS open_issues,
              (SELECT COUNT(*) FROM \`${T.deviceUsers}\` u
                LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id = u.id
                WHERE u.device_id = d.id AND m.id IS NULL) AS unmapped_users
         FROM \`${T.devices}\` d
        ORDER BY d.status = 'active' DESC, d.last_seen_at DESC, d.id ASC
        LIMIT 500`,
      deviceParams
    );

    const [mappingRows] = await this.pool.execute(
      `SELECT
        (SELECT COUNT(*) FROM \`${T.people}\`) AS people_total,
        (SELECT COUNT(*) FROM \`${T.people}\` p WHERE p.status = 'active') AS active_people,
        (SELECT COUNT(*) FROM \`${T.deviceUsers}\`) AS device_users_total,
        (SELECT COUNT(*) FROM \`${T.personDeviceUsers}\` m WHERE m.status = 'active') AS active_mappings,
        (SELECT COUNT(*) FROM \`${T.deviceUsers}\` u LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id = u.id WHERE m.id IS NULL) AS unmapped_device_users,
        (SELECT COUNT(*) FROM \`${T.personDeviceUsers}\` m WHERE m.status <> 'active') AS inactive_mappings,
        (SELECT COUNT(*) FROM \`${T.people}\` p WHERE NOT EXISTS (SELECT 1 FROM \`${T.personDeviceUsers}\` m WHERE m.person_id = p.id AND m.status = 'active')) AS people_without_devices,
        (SELECT COUNT(*) FROM (SELECT m.person_id FROM \`${T.personDeviceUsers}\` m WHERE m.status = 'active' GROUP BY m.person_id HAVING COUNT(*) > 1) multi) AS people_multi_device`
    );

    const issueParams = [];
    const reportIssueRange = sqlRange('i.first_seen_at', range, issueParams);
    const visibleIssueClause = "(i.issue_type <> 'automatic_finalization_pending' OR i.status = 'open')";
    const issueWhere = reportIssueRange ? `WHERE ${reportIssueRange} AND ${visibleIssueClause}` : `WHERE ${visibleIssueClause}`;
    const [issueSummaryRows] = await this.pool.execute(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(i.status = 'resolved'), 0) AS resolved,
              COALESCE(SUM(i.status = 'open'), 0) AS open
         FROM \`${T.finalizationIssues}\` i
         ${issueWhere}`,
      issueParams
    );
    const [recentIssueRows] = await this.pool.execute(
      `${issueSelect()}
       ${issueWhere}
       ORDER BY i.last_seen_at DESC, i.id DESC
       LIMIT 12`,
      issueParams
    );

    const health = numbers(healthRows?.[0], ['canonical_punches', 'final_events', 'issues_in_period', 'open_issues_now', 'unmapped_now']);
    return {
      period: range,
      systemHealth: health,
      devices: (deviceRows ?? []).map((row) => ({
        ...row,
        final_events_in_period: Number(row.final_events_in_period ?? 0),
        open_issues: Number(row.open_issues ?? 0),
        unmapped_users: Number(row.unmapped_users ?? 0)
      })),
      mapping: numbers(mappingRows?.[0], [
        'people_total', 'active_people', 'device_users_total', 'active_mappings',
        'unmapped_device_users', 'inactive_mappings', 'people_without_devices', 'people_multi_device'
      ]),
      issues: {
        ...numbers(issueSummaryRows?.[0], ['total', 'resolved', 'open']),
        items: recentIssueRows ?? []
      }
    };
  }

  async listOpenUnmappedPunchIdsForDeviceUserRowId(deviceUserRowId, { limit = 100 } = {}) {
    const id = normalizeId(deviceUserRowId, 'deviceUserRowId');
    const safeLimit = boundedInteger(limit, 1, 500, 100);
    const [rows] = await this.pool.execute(
      `SELECT i.source_punch_id
         FROM \`${T.finalizationIssues}\` i
         JOIN \`${T.punches}\` p ON p.id = i.source_punch_id
         JOIN \`${T.deviceUsers}\` du
           ON du.device_id = p.device_id AND du.device_user_id = p.device_user_id
        WHERE i.status = 'open'
          AND i.issue_type = 'unmapped_device_user'
          AND du.id = ?
        ORDER BY i.first_seen_at ASC, i.id ASC
        LIMIT ${safeLimit}`,
      [id]
    );
    return (rows ?? []).map((row) => Number(row.source_punch_id)).filter(Number.isSafeInteger);
  }
}

function eventSelect() {
  return `SELECT f.id, f.final_event_uuid, f.person_code, p.display_name AS person_name,
                 f.event_type, f.event_time_local, f.event_timezone, f.event_time_utc,
                 f.verification_method, f.finalization_version, f.status, f.finalized_at,
                 d.vendor, d.serial_number, d.display_name AS device_display_name, d.model AS device_model
            FROM \`${T.finalEvents}\` f
            LEFT JOIN \`${T.people}\` p ON p.id = f.person_id
            LEFT JOIN \`${T.devices}\` d ON d.id = f.device_id`;
}

function issueJoins() {
  return `FROM \`${T.finalizationIssues}\` i
          JOIN \`${T.punches}\` p ON p.id = i.source_punch_id
          JOIN \`${T.devices}\` d ON d.id = p.device_id
          LEFT JOIN \`${T.deviceUsers}\` du
            ON du.device_id = p.device_id AND du.device_user_id = p.device_user_id
          LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id = du.id
          LEFT JOIN \`${T.people}\` person ON person.id = m.person_id`;
}

function issueSelect() {
  return `SELECT i.id, i.issue_type, i.status,
                 i.first_seen_at, i.last_seen_at, i.resolved_at, i.resolution_note,
                 p.device_id, p.device_user_id, p.punch_state,
                 p.device_event_time_local, p.device_timezone, p.device_event_time_utc,
                 d.vendor, d.serial_number, d.display_name AS device_display_name,
                 person.person_code, person.display_name AS person_name
          ${issueJoins()}`;
}

function finalEventFilters(filters) {
  const clauses = [];
  const params = [];
  const text = optionalSearch(filters.search);
  if (text) {
    const like = `%${text}%`;
    clauses.push('(f.person_code LIKE ? OR p.display_name LIKE ?)');
    params.push(like, like);
  }
  const eventType = optionalEnum(filters.eventType, EVENT_TYPES, 'eventType');
  if (eventType) { clauses.push('f.event_type = ?'); params.push(eventType); }
  const verificationMethod = optionalEnum(filters.verificationMethod, VERIFICATION_METHODS, 'verificationMethod');
  if (verificationMethod) {
    if (verificationMethod === 'unknown') clauses.push("(f.verification_method IS NULL OR f.verification_method = '' OR f.verification_method = 'unknown')");
    else { clauses.push('f.verification_method = ?'); params.push(verificationMethod); }
  }
  const deviceId = optionalPositiveId(filters.deviceId, 'deviceId');
  if (deviceId) { clauses.push('f.device_id = ?'); params.push(deviceId); }
  addDayRange(clauses, params, 'f.event_time_local', filters.from, filters.to);
  return { clauses, params };
}

function addDayRange(clauses, params, column, from, to) {
  const range = normalizedDayRange(from, to);
  if (!range) return;
  if (range.from) { clauses.push(`${column} >= ?`); params.push(`${range.from} 00:00:00`); }
  if (range.toExclusive) { clauses.push(`${column} < ?`); params.push(`${range.toExclusive} 00:00:00`); }
}

function sqlRange(column, range, params) {
  if (!range) return '';
  const parts = [];
  if (range.from) { parts.push(`${column} >= ?`); params.push(`${range.from} 00:00:00`); }
  if (range.toExclusive) { parts.push(`${column} < ?`); params.push(`${range.toExclusive} 00:00:00`); }
  return parts.join(' AND ');
}

function normalizedDayRange(from, to) {
  const start = optionalDay(from, 'from');
  const end = optionalDay(to, 'to');
  if (!start && !end) return null;
  if (start && end && start > end) throw new TypeError('from must be on or before to');
  return { from: start, to: end, toExclusive: end ? addOneDay(end) : null };
}

function optionalDay(value, name) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new TypeError(`${name} must be YYYY-MM-DD`);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError(`${name} must be a valid date`);
  }
  return text;
}

function addOneDay(dayText) {
  const [year, month, day] = dayText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function pageSpec(filters) {
  const number = boundedInteger(filters.page, 1, 1_000_000, 1);
  const limit = boundedInteger(filters.limit, 1, 100, 25);
  return { number, limit, offset: (number - 1) * limit };
}

function paged(rows, totalValue, page) {
  const total = Number(totalValue ?? 0);
  return {
    items: rows ?? [],
    page: {
      number: page.number,
      limit: page.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / page.limit))
    }
  };
}

function normalizeId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${name} must be a positive integer`);
  return id;
}

function optionalPositiveId(value, name) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return normalizeId(text, name);
}

function boundedInteger(value, min, max, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

function optionalSearch(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, 100).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function optionalToken(value, name) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(text)) throw new TypeError(`${name} is invalid`);
  return text;
}

function optionalEnum(value, allowed, name) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!allowed.has(text)) throw new TypeError(`${name} is invalid`);
  return text;
}

function normalizeUuid(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
    throw new TypeError('finalEventUuid is invalid');
  }
  return text;
}

function numbers(row, keys) {
  return Object.fromEntries(keys.map((key) => [key, Number(row?.[key] ?? 0)]));
}
