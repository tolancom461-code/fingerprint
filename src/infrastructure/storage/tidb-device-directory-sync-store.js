import { createHash } from 'node:crypto';
import { evaluateDeviceRequestPolicy } from '../../domain/device-policy.js';
import { BIOMETRIC_TABLES as T } from './biometric-table-names.js';
import { lockDeviceForUserIdentity } from './tidb-device-store.js';

const MAX_PROFILES = 10000;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const MAX_UNSIGNED_ID = 18446744073709551615n;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ARCHIVED = 'absent_from_device';
const CHECKPOINT = 'device_user_directory_checkpoint';
const CURRENT_STATUSES = new Set(['seen', 'active', 'disabled']);
const METADATA_KEYS = ['Pri', 'Grp', 'TZ', 'Verify', 'StartDatetime', 'EndDatetime'];
const PIN = /^[A-Za-z0-9._-]{1,128}$/;
const UTC = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.(\d{3})Z$/;
const SQL_DATE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/;

export class TiDbDeviceDirectorySyncStore {
  constructor(pool) { this.pool = pool; }

  async reconcile(observation) {
    const snapshot = checkedObservation(observation);
    let connection;
    try {
      const [matches] = await this.pool.execute(
        `SELECT id FROM \`${T.devices}\` WHERE vendor = ? AND serial_number = ? LIMIT 1`,
        [snapshot.vendor, snapshot.serialNumber]);
      if (matches?.length !== 1) throw stop('DEVICE_DIRECTORY_DEVICE_REJECTED');
      const deviceId = checkedId(matches[0].id);
      connection = await this.pool.getConnection();
      await connection.beginTransaction({ readCommitted: true });
      await lockDeviceForUserIdentity(connection, deviceId);
      await checkDevice(connection, deviceId, snapshot);

      const prior = await loadCheckpoint(connection, deviceId);
      if (prior?.observedAtUtc === snapshot.observedAtUtc && prior.rosterSha256 === snapshot.rosterSha256) {
        await connection.rollback();
        return { ...resultCounts(), replayed: true };
      }
      if (prior && prior.observedAtUtc >= snapshot.observedAtUtc) throw stop('DEVICE_DIRECTORY_STALE_OBSERVATION');

      const identities = await loadIdentities(connection, deviceId);
      const counts = resultCounts();
      await applyCurrentProfiles(connection, deviceId, identities, snapshot, prior, counts);
      const pending = await applyMissingProfiles(connection, deviceId, identities.current, snapshot, prior, counts);
      await appendAudit(connection, CHECKPOINT, 'device', deviceId, null, {
        version: 1,
        observedAtUtc: snapshot.observedAtUtc,
        rosterSha256: snapshot.rosterSha256,
        pins: snapshot.pins,
        missingIdentities: pending
      });
      await connection.commit();
      return { ...counts, pendingRemovalCount: pending.length, replayed: false };
    } catch (error) {
      try { await connection?.rollback(); } catch { /* Keep the safe reconciliation failure. */ }
      throw error instanceof DirectorySyncError ? error : stop('DEVICE_DIRECTORY_SYNC_FAILED');
    } finally {
      connection?.release();
    }
  }
}

async function checkDevice(connection, deviceId, snapshot) {
  const [rows] = await connection.execute(
    `SELECT id, vendor, serial_number, status, mode FROM \`${T.devices}\` WHERE id = ? FOR UPDATE`, [deviceId]);
  const device = rows?.[0];
  if (rows?.length !== 1 || checkedId(device.id) !== deviceId || device.vendor !== snapshot.vendor ||
      device.serial_number !== snapshot.serialNumber || !evaluateDeviceRequestPolicy(device).allowed) {
    throw stop('DEVICE_DIRECTORY_DEVICE_REJECTED');
  }
}

async function loadCheckpoint(connection, deviceId) {
  const [rows] = await connection.execute(
    `SELECT after_state FROM \`${T.auditLog}\`
      WHERE action_type = 'device_user_directory_checkpoint' AND entity_type = 'device' AND entity_id = ?
      ORDER BY JSON_UNQUOTE(JSON_EXTRACT(after_state, '$.observedAtUtc')) DESC, id DESC LIMIT 1`, [deviceId]);
  if (!rows.length) return null;
  try {
    const raw = rows[0].after_state;
    if (typeof raw === 'string' && Buffer.byteLength(raw) > MAX_AUDIT_BYTES) throw stop('DEVICE_DIRECTORY_CHECKPOINT_INVALID');
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value?.version !== 1 || typeof value.rosterSha256 !== 'string' || !SHA256_HEX.test(value.rosterSha256) ||
        !Array.isArray(value.pins) || value.pins.length > MAX_PROFILES ||
        !Array.isArray(value.missingIdentities) || value.missingIdentities.length > MAX_PROFILES) {
      throw stop('DEVICE_DIRECTORY_CHECKPOINT_INVALID');
    }
    const observedAtUtc = checkedUtc(value.observedAtUtc);
    const pins = new Set();
    let previousPin = '';
    for (const pin of value.pins) {
      if (!validPin(pin) || pin <= previousPin) throw stop('DEVICE_DIRECTORY_CHECKPOINT_INVALID');
      pins.add(pin);
      previousPin = pin;
    }
    const missingIdentities = new Set(value.missingIdentities.map(checkedId));
    if (missingIdentities.size !== value.missingIdentities.length) throw stop('DEVICE_DIRECTORY_CHECKPOINT_INVALID');
    return { observedAtUtc, observedSql: toSql(observedAtUtc), rosterSha256: value.rosterSha256, pins, missingIdentities };
  } catch { throw stop('DEVICE_DIRECTORY_CHECKPOINT_INVALID'); }
}

async function loadIdentities(connection, deviceId) {
  const [rows] = await connection.execute(
    `SELECT id, device_user_id, display_name, status, first_seen_at, last_seen_at, safe_metadata, identity_started_at, identity_ended_at
      FROM \`${T.deviceUsers}\` WHERE device_id = ? ORDER BY id FOR UPDATE`, [deviceId]);
  const current = new Map();
  const historical = new Map();
  for (const row of rows) {
    const id = checkedId(row.id);
    const pin = checkedPin(row.device_user_id);
    const start = checkedSqlDate(row.identity_started_at);
    const end = checkedSqlDate(row.identity_ended_at);
    if (start && end && start >= end) throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
    if (row.status === ARCHIVED) {
      const previous = historical.get(pin);
      if (!previous || (end && (!previous.end || end > previous.end))) historical.set(pin, { end });
    } else {
      if (!CURRENT_STATUSES.has(row.status) || end || current.has(pin)) throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
      const storedMetadata = readStoredMetadata(row.safe_metadata);
      current.set(pin, { id, deviceUserId: pin, displayName: checkedName(row.display_name), status: row.status, start,
        storedMetadata, metadata: projectMetadata(storedMetadata),
        firstSeen: checkedSqlDate(row.first_seen_at), lastSeen: checkedSqlDate(row.last_seen_at) });
    }
  }
  return { current, historical };
}

async function applyCurrentProfiles(connection, deviceId, identities, snapshot, prior, counts) {
  for (const [pin, profile] of snapshot.profiles) {
    const current = identities.current.get(pin);
    const name = profile.nameReported ? profile.displayName : current?.displayName ?? null;
    const retired = identities.historical.get(pin);
    if (atOrAfter(retired?.end, snapshot.observedSql)) throw stop('DEVICE_DIRECTORY_STALE_OBSERVATION');
    if (!current) {
      const start = retired || prior ? snapshot.observedSql : null;
      const [result] = await connection.execute(
        `INSERT INTO \`${T.deviceUsers}\`
          (device_id, device_user_id, display_name, status, metadata_schema_version, safe_metadata, identity_started_at, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, 'seen', 1, ?, ?, ?, ?)`,
        [deviceId, pin, name, metadataJson(profile.metadata), start, snapshot.observedSql, snapshot.observedSql]);
      requireChanged(result);
      await appendAudit(connection, 'device_user_added', 'device_user', checkedId(result.insertId), null,
        auditState(pin, name, 'seen', profile.metadata));
      counts.addedCount++;
      continue;
    }

    const changedMetadata = Object.entries(profile.metadata).some(([key, value]) => current.metadata[key] !== value);
    const changedRow = name !== current.displayName || changedMetadata;
    if (current.start > snapshot.observedSql || current.firstSeen > snapshot.observedSql ||
        (current.lastSeen > snapshot.observedSql && changedRow)) throw stop('DEVICE_DIRECTORY_STALE_OBSERVATION');
    const newPlaceholder = prior && !prior.pins.has(pin) && !prior.missingIdentities.has(current.id) &&
      !retired && current.firstSeen > prior.observedSql;
    if (!newPlaceholder && !changedRow) continue;
    const metadataAfter = { ...current.metadata, ...profile.metadata };
    if (changedRow) {
      const [result] = await connection.execute(
        `UPDATE \`${T.deviceUsers}\` SET display_name = ?, safe_metadata = ?
          WHERE id = ? AND device_id = ? AND status = ? AND identity_ended_at IS NULL`,
        [name, metadataJson({ ...current.storedMetadata, ...profile.metadata }), current.id, deviceId, current.status]);
      requireChanged(result);
    }
    const before = auditState(pin, current.displayName, current.status, current.metadata);
    const after = auditState(pin, name, current.status, metadataAfter);
    if (newPlaceholder) {
      await appendAudit(connection, 'device_user_added', 'device_user', current.id, before, after);
      counts.addedCount++;
    } else {
      await appendAudit(connection, 'device_user_updated', 'device_user', current.id, before, after);
      counts.updatedCount++;
    }
  }
}

async function applyMissingProfiles(connection, deviceId, current, snapshot, prior, counts) {
  const pending = [];
  for (const [pin, user] of current) {
    if (snapshot.profiles.has(pin)) continue;
    const previousMissing = prior?.missingIdentities.has(user.id);
    if (!previousMissing) {
      if (!newerThanCutoff(user, snapshot.observedSql)) pending.push(user.id);
      continue;
    }
    // Read committed sees activity written before acquisition of the shared device lock.
    const [punches] = await connection.execute(
      `SELECT device_event_time_utc FROM \`${T.punches}\` WHERE device_user_row_id = ?
        ORDER BY device_event_time_utc DESC LIMIT 1`, [user.id]);
    const latestPunch = checkedSqlDate(punches?.[0]?.device_event_time_utc ?? null);
    const cutoff = prior.observedSql;
    if (newerThanCutoff(user, cutoff) || atOrAfter(latestPunch, cutoff)) {
      if (!newerThanCutoff(user, snapshot.observedSql) && !atOrAfter(latestPunch, snapshot.observedSql)) {
        pending.push(user.id);
      }
      continue;
    }
    const [result] = await connection.execute(
      `UPDATE \`${T.deviceUsers}\` SET status = ?, identity_ended_at = ?
        WHERE id = ? AND device_id = ? AND status = ? AND identity_ended_at IS NULL`,
      [ARCHIVED, cutoff, user.id, deviceId, user.status]);
    requireChanged(result);
    await appendAudit(connection, 'device_user_archived', 'device_user', user.id,
      auditState(pin, user.displayName, user.status, user.metadata), auditState(pin, user.displayName, ARCHIVED, user.metadata));
    counts.archivedCount++;
  }
  if (pending.length > MAX_PROFILES) throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
  return pending;
}

function newerThanCutoff(user, cutoff) {
  return [user.start, user.firstSeen, user.lastSeen].some(value => atOrAfter(value, cutoff));
}

function atOrAfter(value, cutoff) { return value != null && value >= cutoff; }

function auditState(deviceUserId, displayName, status, metadata) {
  return { deviceUserId, displayName, status, ...(Object.keys(metadata).length ? { metadata } : {}) };
}

async function appendAudit(connection, action, entity, entityId, before, after) {
  const beforeJson = before === null ? null : JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  if ((beforeJson && Buffer.byteLength(beforeJson) > MAX_AUDIT_BYTES) || Buffer.byteLength(afterJson) > MAX_AUDIT_BYTES) {
    throw stop('DEVICE_DIRECTORY_OBSERVATION_REJECTED');
  }
  const [result] = await connection.execute(
    `INSERT INTO \`${T.auditLog}\` (
       actor_type, actor_reference, action_type, entity_type, entity_id,
       before_state, after_state, notes, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))`,
    ['system', 'verified-device-directory', action, entity, entityId, beforeJson, afterJson, null]);
  requireChanged(result);
}

function checkedObservation(value) {
  try {
    const { device, observedAtUtc, profiles, userCount } = value;
    if (device?.vendor !== 'zkteco' || !validPin(device.serialNumber) || !Number.isSafeInteger(userCount)) throw stop();
    const when = checkedUtc(observedAtUtc);
    if (Date.parse(when) > Date.now()) throw stop();
    const profileMap = checkedProfiles(profiles);
    if (profileMap.size !== userCount) throw stop();
    const pins = [...profileMap.keys()].sort();
    return { vendor: device.vendor, serialNumber: device.serialNumber, observedAtUtc: when, observedSql: toSql(when),
      profiles: profileMap, pins, rosterSha256: rosterHash(pins, profileMap) };
  } catch { throw stop('DEVICE_DIRECTORY_OBSERVATION_REJECTED'); }
}

function checkedProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length > MAX_PROFILES) throw stop('DEVICE_DIRECTORY_OBSERVATION_REJECTED');
  const result = new Map();
  for (const profile of profiles) {
    const pin = checkedPin(profile?.deviceUserId);
    if (result.has(pin)) throw stop('DEVICE_DIRECTORY_OBSERVATION_REJECTED');
    const nameReported = profile.nameReported === undefined ? true : profile.nameReported;
    if (typeof nameReported !== 'boolean') throw stop('DEVICE_DIRECTORY_OBSERVATION_REJECTED');
    const displayName = nameReported ? checkedName(profile.displayName) : null;
    result.set(pin, { displayName, nameReported, metadata: checkedMetadata(profile.metadata) });
  }
  return result;
}

function rosterHash(pins, profiles) {
  const hash = createHash('sha256');
  for (const deviceUserId of pins) {
    hash.update(JSON.stringify({ deviceUserId, ...profiles.get(deviceUserId) }));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function checkedMetadata(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).some(key => !METADATA_KEYS.includes(key) || !safeMetadataValue(value[key]))) {
    throw stop('DEVICE_DIRECTORY_OBSERVATION_REJECTED');
  }
  return projectMetadata(value);
}

function safeMetadataValue(value) {
  return typeof value === 'string' && value.length <= 256 && !/[\p{Cc}\uFFFD]/u.test(value) &&
    value !== '[REDACTED]' && !value.startsWith('[OMITTED:');
}

function projectMetadata(value) {
  return Object.fromEntries(METADATA_KEYS.filter(key => Object.hasOwn(value, key) && safeMetadataValue(value[key]))
    .map(key => [key, value[key]]));
}

function readStoredMetadata(value) {
  if (value === null) return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
  return parsed;
}

function metadataJson(metadata) { return Object.keys(metadata).length ? JSON.stringify(metadata) : null; }

function checkedId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > MAX_UNSIGNED_ID) {
    throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
  }
  return value;
}

function validPin(value) { return typeof value === 'string' && PIN.test(value); }

function checkedPin(value) {
  if (!validPin(value)) throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
  return value;
}

function checkedName(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > 255 || value.trim() !== value ||
      /[\p{Cc}\uFFFD]/u.test(value) || value === '[REDACTED]' || value.startsWith('[OMITTED:')) {
    throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
  }
  return value;
}

function checkedUtc(value) {
  if (typeof value !== 'string' || !UTC.test(value)) throw stop('DEVICE_DIRECTORY_OBSERVATION_REJECTED');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw stop('DEVICE_DIRECTORY_OBSERVATION_REJECTED');
  return value;
}

function checkedSqlDate(value) {
  if (value === null) return null;
  const match = typeof value === 'string' && SQL_DATE.exec(value);
  if (!match) throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
  const [, day, time, fraction = ''] = match;
  checkedUtc(`${day}T${time}.${fraction.padEnd(6, '0').slice(0, 3)}Z`);
  return `${day} ${time}.${fraction.padEnd(6, '0')}`;
}

function toSql(utc) { return `${utc.slice(0, -1).replace('T', ' ')}000`; }

function requireChanged(result) {
  if (result?.affectedRows !== 1) throw stop('DEVICE_DIRECTORY_IDENTITY_CONFLICT');
}

function resultCounts() { return { addedCount: 0, updatedCount: 0, archivedCount: 0, pendingRemovalCount: 0 }; }

class DirectorySyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function stop(code = 'DEVICE_DIRECTORY_OBSERVATION_REJECTED') { return new DirectorySyncError(code); }
