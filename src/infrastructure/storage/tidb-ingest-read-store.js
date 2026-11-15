import { TiDbAdminReadStore } from './tidb-admin-read-store.js';
import { BIOMETRIC_TABLES as T } from './biometric-table-names.js';
import { normalizeZktecoAttendance } from '../vendors/zkteco/attlog-normalization.js';

const profileFields = ['Pri', 'Grp', 'TZ', 'Verify', 'StartDatetime', 'EndDatetime'];

export class TiDbIngestReadStore extends TiDbAdminReadStore {
  constructor(pool, { deviceUserIdentityEnabled = false, directorySyncEnabled = false } = {}) {
    super(pool, { deviceUserIdentityEnabled });
    this.ingestReadPool = pool;
    this.directorySyncEnabled = directorySyncEnabled;
  }

  async getIntakeCounts() {
    const [rows] = await this.ingestReadPool.execute(`SELECT
      (SELECT COUNT(*) FROM \`${T.ingestEvents}\`) AS received,
      (SELECT COUNT(*) FROM \`${T.deviceUsers}\` WHERE status <> 'absent_from_device') AS device_users,
      (SELECT COUNT(*) FROM \`${T.deviceUsers}\` WHERE status = 'absent_from_device') AS historical_device_users,
      (SELECT COUNT(*) FROM \`${T.deviceUsers}\`) AS all_device_users`);
    const row = rows?.[0];
    const counts = rosterCounts(row?.device_users, row?.historical_device_users, row?.all_device_users);
    return { received: Number(row?.received), deviceUsers: counts.current,
      ...(counts.historical ? { historicalDeviceUsers: counts.historical, allDeviceUsers: counts.all } : {}) };
  }

  async pageReceivedPunches({ page, limit, search, deviceUserRowId }) {
    const paging = pagination(page, limit);
    const byIdentity = deviceUserRowId !== undefined;
    if (byIdentity && (!this.deviceUserIdentityEnabled || !validRowId(deviceUserRowId))) throw invalid();
    const userId = "COALESCE(p.device_user_id,JSON_UNQUOTE(JSON_EXTRACT(i.safe_payload,'$.deviceUserId')))";
    const joins = `FROM \`${T.ingestEvents}\` i
      JOIN \`${T.devices}\` d ON d.id=i.device_id
      LEFT JOIN \`${T.punches}\` p ON p.ingest_event_id=i.id
      LEFT JOIN \`${T.eventProcessing}\` ep ON ep.ingest_event_id=i.id`;
    const clauses = [];
    const params = [];
    if (byIdentity) {
      clauses.push('p.device_user_row_id = CAST(? AS UNSIGNED)');
      params.push(deviceUserRowId);
    }
    if (search) {
      clauses.push(`(${userId} LIKE ? ESCAPE '!' OR d.display_name LIKE ? ESCAPE '!' OR d.serial_number LIKE ? ESCAPE '!')`);
      params.push(...Array(3).fill(like(search)));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const details = byIdentity ? ', p.raw_status AS device_punch_state, p.punch_state, p.vendor AS punch_vendor' : '';
    const order = byIdentity ? 'p.device_event_time_local DESC,p.id DESC' : 'i.received_at DESC,i.id DESC';
    const [[items], [counts]] = await Promise.all([
      this.ingestReadPool.execute(`SELECT i.id, ${userId} AS device_user_id,
        COALESCE(p.device_event_time_raw,JSON_UNQUOTE(JSON_EXTRACT(i.safe_payload,'$.deviceEventTime'))) AS device_event_time_local,
        p.device_event_time_utc, i.received_at, i.parse_valid,
        COALESCE(ep.status,'pending') AS processing_status,
        EXISTS(SELECT 1 FROM \`${T.finalEvents}\` f WHERE f.source_punch_id=p.id) AS has_final_event,
        COALESCE(d.display_name,d.serial_number) AS device_name, d.serial_number${details}
        ${joins} ${where} ORDER BY ${order} LIMIT ${paging.limit} OFFSET ${paging.offset}`, params),
      this.ingestReadPool.execute(`SELECT COUNT(*) AS total ${joins} ${where}`, params)
    ]);
    return paged(byIdentity ? items.map(withPunchState) : items, counts?.[0]?.total, page, limit);
  }

  async pageDeviceUserChanges({ page, limit, search, kind }) {
    const paging = pagination(page, limit);
    if (!this.directorySyncEnabled || !['added', 'updated'].includes(kind)) throw invalid();
    const beforeName = auditField('before_state', 'displayName');
    const afterName = auditField('after_state', 'displayName');
    const joins = `FROM \`${T.auditLog}\` a
      JOIN \`${T.deviceUsers}\` u ON u.id = a.entity_id
      JOIN \`${T.devices}\` d ON d.id = u.device_id`;
    const params = [`device_user_${kind}`];
    let where = "WHERE a.entity_type = 'device_user' AND a.action_type = ?";
    if (search) {
      where += ` AND (u.device_user_id LIKE ? ESCAPE '!' OR d.display_name LIKE ? ESCAPE '!'
        OR ${beforeName} LIKE ? ESCAPE '!' OR ${afterName} LIKE ? ESCAPE '!')`;
      params.push(...Array(4).fill(like(search)));
    }
    const metadataColumns = ['before', 'after'].flatMap(snapshot => profileFields.map(field =>
      `${auditField(`${snapshot}_state`, `metadata.${field}`)} AS ${snapshot}_${field.toLowerCase()}`));
    const [[items], [counts]] = await Promise.all([
      this.ingestReadPool.execute(`SELECT a.id, a.entity_id AS device_user_row_id, u.device_user_id,
        COALESCE(d.display_name, d.serial_number) AS device_name, a.occurred_at,
        ${beforeName} AS before_display_name, ${auditField('before_state', 'status')} AS before_status,
        ${afterName} AS after_display_name, ${auditField('after_state', 'status')} AS after_status,
        ${metadataColumns.join(',\n        ')}
        ${joins} ${where} ORDER BY a.occurred_at DESC,a.id DESC LIMIT ${paging.limit} OFFSET ${paging.offset}`, params),
      this.ingestReadPool.execute(`SELECT COUNT(*) AS total ${joins} ${where}`, params)
    ]);
    return paged(items, counts?.[0]?.total, page, limit);
  }

  async pageDeviceUsers({ page, limit, search, roster = 'current' }) {
    const paging = pagination(page, limit);
    if (!['current', 'historical', 'all'].includes(roster)) throw invalid();
    const joins = `FROM \`${T.deviceUsers}\` u
      JOIN \`${T.devices}\` d ON d.id=u.device_id
      LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id=u.id AND m.status='active'
      LEFT JOIN \`${T.people}\` p ON p.id=m.person_id`;
    const clauses = [];
    if (roster === 'current') clauses.push("u.status <> 'absent_from_device'");
    if (roster === 'historical') clauses.push("u.status = 'absent_from_device'");
    if (search) clauses.push(`(u.device_user_id LIKE ? ESCAPE '!' OR u.display_name LIKE ? ESCAPE '!' OR d.display_name LIKE ? ESCAPE '!' OR p.person_code LIKE ? ESCAPE '!')`);
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const params = search ? Array(4).fill(like(search)) : [];
    const [[items], [counts], [rosterRows]] = await Promise.all([
      this.ingestReadPool.execute(`SELECT u.id,u.device_user_id,u.display_name,u.status,u.last_seen_at,
        COALESCE(d.display_name,d.serial_number) AS device_name,p.person_code AS mapped_person_code,p.display_name AS mapped_person_name
        ${joins} ${where} ORDER BY u.last_seen_at DESC,u.id DESC LIMIT ${paging.limit} OFFSET ${paging.offset}`, params),
      this.ingestReadPool.execute(`SELECT COUNT(*) AS total ${joins} ${where}`, params),
      this.ingestReadPool.execute(`SELECT COUNT(*) AS all_device_users,
        COALESCE(SUM(status <> 'absent_from_device'),0) AS current_device_users,
        COALESCE(SUM(status = 'absent_from_device'),0) AS historical_device_users FROM \`${T.deviceUsers}\``)
    ]);
    const totals = rosterCounts(rosterRows?.[0]?.current_device_users, rosterRows?.[0]?.historical_device_users, rosterRows?.[0]?.all_device_users);
    return { ...paged(items, counts?.[0]?.total, page, limit), ...(totals.historical ? { rosterCounts: totals } : {}) };
  }
}
function withPunchState(row) {
  if (row.punch_vendor !== 'zkteco') return row;
  const { profileId, punchState } = normalizeZktecoAttendance({ serialNumber: row.serial_number, rawStatus: row.device_punch_state });
  return profileId && row.device_punch_state != null ? { ...row, punch_state: punchState } : row;
}
function auditField(column, field) {
  const value = `JSON_EXTRACT(a.${column}, '$.${field}')`;
  return `CASE WHEN JSON_TYPE(${value}) = 'STRING' THEN JSON_UNQUOTE(${value}) ELSE NULL END`;
}
function validRowId(value) { return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n; }
function rosterCounts(current, historical, all) {
  const counts = { current: Number(current), historical: Number(historical), all: Number(all) };
  if (Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0) || counts.current + counts.historical !== counts.all) {
    throw Object.assign(new Error('Device roster counts are invalid'), { code: 'INGEST_PORTAL_DATA_INVALID' });
  }
  return counts;
}
function invalid() { return Object.assign(new TypeError('Invalid intake list filters'), { code: 'INVALID_INPUT', status: 400 }); }
function like(value) { return `%${value.replace(/[!%_]/g, character => '!' + character)}%`; }
function pagination(page, limit) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw Object.assign(new TypeError('Invalid intake pagination'), { code: 'INVALID_INPUT', status: 400 });
  }
  // TiDB rejects mysql2's DOUBLE binding for LIMIT/OFFSET. Use bounded integers,
  // as the existing admin read store does; search data remains parameterized.
  return { limit, offset: (page - 1) * limit };
}
function paged(items, count, number, limit) {
  const total = Number(count);
  return { items, page: { number, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}
