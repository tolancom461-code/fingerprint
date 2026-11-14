import { createHash } from 'node:crypto';
import { BIOMETRIC_TABLES as T } from './biometric-table-names.js';
import { TiDbAuditStore } from './tidb-audit-store.js';

const historical = 'absent_from_device';
const actionType = 'device_user_roster_verified';

// Use one dedicated connection and a complete, authenticated roster observation.
// A USER message or a punch does not authorize retirement or reuse of a number.
export async function reconcileDeviceUserRoster(connection, {
  vendor, serialNumber, observedAtUtc, deviceUserIds
}, { commit = false } = {}) {
  const pins = checkedPins(deviceUserIds);
  const observed = new Date(observedAtUtc);
  if (vendor !== 'zkteco' || !validKey(serialNumber) || typeof commit !== 'boolean' ||
      typeof observedAtUtc !== 'string' || !observedAtUtc.endsWith('Z') || !Number.isFinite(observed.getTime()) ||
      observed.getTime() > Date.now()) throw stop('DEVICE_ROSTER_OBSERVATION_REJECTED');
  const observedIso = observed.toISOString();
  const observedSql = observedIso.slice(0, -1).replace('T', ' ');
  const digest = createHash('sha256').update(JSON.stringify([...pins].sort())).digest('hex');

  const [[identity]] = await connection.execute('SELECT DATABASE() AS selected_database');
  if (identity?.selected_database !== 'fingerprint') throw stop('DEVICE_ROSTER_DATABASE_REJECTED');

  // Read the latest audit checkpoint after acquiring the device lock, including on TiDB.
  await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await connection.beginTransaction();
  try {
    const [devices] = await connection.execute(
      `SELECT id, vendor, serial_number, status FROM \`${T.devices}\` WHERE vendor = ? AND serial_number = ? FOR UPDATE`,
      [vendor, serialNumber]
    );
    const [device] = devices;
    if (devices.length !== 1 || device.vendor !== vendor || device.serial_number !== serialNumber || device.status !== 'active') {
      throw stop('DEVICE_ROSTER_DEVICE_REJECTED');
    }

    const [[prior]] = await connection.execute(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(after_state, '$.observedAtUtc')) AS observed_at,
              JSON_UNQUOTE(JSON_EXTRACT(after_state, '$.rosterSha256')) AS roster_sha256
         FROM \`${T.auditLog}\` WHERE action_type = ? AND entity_type = 'device' AND entity_id = ?
        ORDER BY observed_at DESC, id DESC LIMIT 1`, [actionType, device.id]
    );
    if (prior && (typeof prior.observed_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(prior.observed_at) ||
        prior.observed_at > observedIso || (prior.observed_at === observedIso && prior.roster_sha256 !== digest))) {
      throw stop('DEVICE_ROSTER_STALE_OBSERVATION');
    }
    if (prior?.observed_at === observedIso) {
      await connection.rollback();
      return { committed: false, repeated: true, current: pins.size, archived: 0, created: 0, reused: 0 };
    }

    const [identities] = await connection.execute(
      `SELECT id, device_user_id, status, first_seen_at, identity_started_at, identity_ended_at
         FROM \`${T.deviceUsers}\` WHERE device_id = ? FOR UPDATE`, [device.id]
    );
    const current = new Map();
    const known = new Set();
    for (const row of identities) {
      known.add(row.device_user_id);
      if (row.status === historical) {
        if (row.identity_ended_at != null && normalizedSql(row.identity_ended_at) >= normalizedSql(observedSql)) throw stop('DEVICE_ROSTER_STALE_OBSERVATION');
        continue;
      }
      if (current.has(row.device_user_id) || row.identity_ended_at != null) throw stop('DEVICE_ROSTER_IDENTITY_CONFLICT');
      if (row.identity_started_at != null && normalizedSql(row.identity_started_at) >= normalizedSql(observedSql)) throw stop('DEVICE_ROSTER_STALE_OBSERVATION');
      if (!pins.has(row.device_user_id) && row.first_seen_at != null &&
          normalizedSql(row.first_seen_at) > normalizedSql(observedSql)) throw stop('DEVICE_ROSTER_STALE_OBSERVATION');
      current.set(row.device_user_id, row);
    }

    const retire = [...current.values()].filter(row => !pins.has(row.device_user_id));
    const add = [...pins].filter(pin => !current.has(pin));
    for (const row of retire) {
      const [result] = await connection.execute(
        `UPDATE \`${T.deviceUsers}\` SET status = ?, identity_ended_at = ? WHERE id = ? AND device_id = ? AND status = ?`,
        [historical, observedSql, row.id, device.id, row.status]
      );
      if (result.affectedRows !== 1) throw stop('DEVICE_ROSTER_IDENTITY_CONFLICT');
    }
    for (const pin of add) {
      await connection.execute(
        `INSERT INTO \`${T.deviceUsers}\` (device_id, device_user_id, status, identity_started_at, first_seen_at, last_seen_at)
         VALUES (?, ?, 'seen', ?, ?, ?)`, [device.id, pin, observedSql, observedSql, observedSql]
      );
    }
    const summary = { current: pins.size, archived: retire.length, created: add.length, reused: add.filter(pin => known.has(pin)).length };
    await new TiDbAuditStore(connection).append({ actorType: 'admin', actorReference: 'verified-device-roster',
      actionType, entityType: 'device', entityId: device.id,
      afterState: { ...summary, observedAtUtc: observedIso, rosterSha256: digest } });

    if (commit) await connection.commit();
    else await connection.rollback();
    return { committed: commit, repeated: false, ...summary };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

function validKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function checkedPins(values) {
  if (!Array.isArray(values) || values.length > 10000 || values.some(pin => !validKey(pin))) throw stop('DEVICE_ROSTER_OBSERVATION_REJECTED');
  const pins = new Set(values);
  if (pins.size !== values.length) throw stop('DEVICE_ROSTER_OBSERVATION_REJECTED');
  return pins;
}

function normalizedSql(value) {
  const time = value instanceof Date ? value.toISOString().slice(0, -1).replace('T', ' ') : value;
  if (typeof time !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?$/.test(time)) {
    throw stop('DEVICE_ROSTER_IDENTITY_TIMESTAMP_REJECTED');
  }
  return (time.includes('.') ? time : `${time}.`).padEnd(26, '0');
}

function stop(code) {
  return Object.assign(new Error(code), { code });
}
