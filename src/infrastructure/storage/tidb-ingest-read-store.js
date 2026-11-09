import { TiDbAdminReadStore } from './tidb-admin-read-store.js';
import { BIOMETRIC_TABLES as T } from './biometric-table-names.js';

export class TiDbIngestReadStore extends TiDbAdminReadStore {
  constructor(pool) { super(pool); this.ingestReadPool = pool; }

  async getIntakeCounts() {
    const [rows] = await this.ingestReadPool.execute(`SELECT
      (SELECT COUNT(*) FROM \`${T.ingestEvents}\`) AS received,
      (SELECT COUNT(*) FROM \`${T.deviceUsers}\`) AS device_users`);
    return { received: Number(rows?.[0]?.received), deviceUsers: Number(rows?.[0]?.device_users) };
  }

  async pageReceivedPunches({ page, limit, search }) {
    const paging = pagination(page, limit);
    const userId = "COALESCE(p.device_user_id,JSON_UNQUOTE(JSON_EXTRACT(i.safe_payload,'$.deviceUserId')))";
    const joins = `FROM \`${T.ingestEvents}\` i
      JOIN \`${T.devices}\` d ON d.id=i.device_id
      LEFT JOIN \`${T.punches}\` p ON p.ingest_event_id=i.id
      LEFT JOIN \`${T.eventProcessing}\` ep ON ep.ingest_event_id=i.id`;
    const where = search ? `WHERE (${userId} LIKE ? ESCAPE '!' OR d.display_name LIKE ? ESCAPE '!' OR d.serial_number LIKE ? ESCAPE '!')` : '';
    const params = search ? Array(3).fill(like(search)) : [];
    const [[items], [counts]] = await Promise.all([
      this.ingestReadPool.execute(`SELECT i.id, ${userId} AS device_user_id,
        COALESCE(p.device_event_time_raw,JSON_UNQUOTE(JSON_EXTRACT(i.safe_payload,'$.deviceEventTime'))) AS device_event_time_local,
        p.device_event_time_utc, i.received_at, i.parse_valid,
        COALESCE(ep.status,'pending') AS processing_status,
        EXISTS(SELECT 1 FROM \`${T.finalEvents}\` f WHERE f.source_punch_id=p.id) AS has_final_event,
        COALESCE(d.display_name,d.serial_number) AS device_name, d.serial_number
        ${joins} ${where} ORDER BY i.received_at DESC,i.id DESC LIMIT ${paging.limit} OFFSET ${paging.offset}`, params),
      this.ingestReadPool.execute(`SELECT COUNT(*) AS total ${joins} ${where}`, params)
    ]);
    return paged(items, counts?.[0]?.total, page, limit);
  }

  async pageDeviceUsers({ page, limit, search }) {
    const paging = pagination(page, limit);
    const joins = `FROM \`${T.deviceUsers}\` u
      JOIN \`${T.devices}\` d ON d.id=u.device_id
      LEFT JOIN \`${T.personDeviceUsers}\` m ON m.device_user_row_id=u.id AND m.status='active'
      LEFT JOIN \`${T.people}\` p ON p.id=m.person_id`;
    const where = search ? `WHERE (u.device_user_id LIKE ? ESCAPE '!' OR u.display_name LIKE ? ESCAPE '!' OR d.display_name LIKE ? ESCAPE '!' OR p.person_code LIKE ? ESCAPE '!')` : '';
    const params = search ? Array(4).fill(like(search)) : [];
    const [[items], [counts]] = await Promise.all([
      this.ingestReadPool.execute(`SELECT u.id,u.device_user_id,u.display_name,u.status,u.last_seen_at,
        COALESCE(d.display_name,d.serial_number) AS device_name,p.person_code AS mapped_person_code,p.display_name AS mapped_person_name
        ${joins} ${where} ORDER BY u.last_seen_at DESC,u.id DESC LIMIT ${paging.limit} OFFSET ${paging.offset}`, params),
      this.ingestReadPool.execute(`SELECT COUNT(*) AS total ${joins} ${where}`, params)
    ]);
    return paged(items, counts?.[0]?.total, page, limit);
  }
}
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
