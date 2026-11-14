import { createDeviceIdentity } from '../../domain/device-identity.js';
import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const T = BIOMETRIC_TABLES.devices;
const USERS = BIOMETRIC_TABLES.deviceUsers;

// All writes to a device's user identities acquire the same device lock first.
export async function lockDeviceForUserIdentity(connection, deviceId) {
  const [rows] = await connection.execute(
    'SELECT id FROM `biometric_svc_devices` WHERE id = ? FOR UPDATE', [deviceId]);
  if (!Array.isArray(rows) || rows.length !== 1 || String(rows[0].id) !== String(deviceId)) {
    throw new Error('Device user identity lock unavailable');
  }
}

export async function listDeviceUserIdentities(connection, deviceId, deviceUserId) {
  const [rows] = await connection.execute(
    `SELECT id, status, identity_started_at, identity_ended_at
       FROM \`${USERS}\` WHERE device_id = ? AND device_user_id = ? ORDER BY id FOR UPDATE`,
    [deviceId, deviceUserId]);
  return rows;
}

export class TiDbDeviceStore {
  constructor(pool, { deviceUserIdentityEnabled = false } = {}) {
    this.pool = pool;
    this.deviceUserIdentityEnabled = deviceUserIdentityEnabled;
  }

  async observe({ device, remoteAddress = null, observedAt, eventAt = null, metadata = null }) {
    const identity = createDeviceIdentity(device);
    const values = normalizeMetadata(metadata);

    await this.pool.execute(
      `INSERT INTO \`${T}\` (
         vendor, serial_number, display_name, manufacturer, model, protocol, adapter_type,
         firmware_version, platform, oem_vendor, first_seen_at, last_seen_at, last_event_at,
         last_ip_address, safe_capabilities
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = COALESCE(VALUES(display_name), display_name),
         manufacturer = COALESCE(VALUES(manufacturer), manufacturer),
         model = COALESCE(VALUES(model), model),
         protocol = COALESCE(VALUES(protocol), protocol),
         adapter_type = COALESCE(VALUES(adapter_type), adapter_type),
         firmware_version = COALESCE(VALUES(firmware_version), firmware_version),
         platform = COALESCE(VALUES(platform), platform),
         oem_vendor = COALESCE(VALUES(oem_vendor), oem_vendor),
         last_seen_at = VALUES(last_seen_at),
         last_event_at = CASE
           WHEN VALUES(last_event_at) IS NULL THEN last_event_at
           WHEN last_event_at IS NULL OR last_event_at < VALUES(last_event_at) THEN VALUES(last_event_at)
           ELSE last_event_at
         END,
         last_ip_address = COALESCE(VALUES(last_ip_address), last_ip_address),
         safe_capabilities = COALESCE(VALUES(safe_capabilities), safe_capabilities)`,
      [
        identity.vendor,
        identity.serialNumber,
        values.displayName,
        values.manufacturer,
        values.model,
        values.protocol,
        values.adapterType,
        values.firmwareVersion,
        values.platform,
        values.oemVendor,
        observedAt,
        observedAt,
        eventAt,
        remoteAddress,
        jsonOrNull(values.safeCapabilities)
      ]
    );

    return this.get(device);
  }

  async get(device) {
    const identity = createDeviceIdentity(device);
    const [rows] = await this.pool.execute(
      `SELECT id, vendor, serial_number, status, mode, timezone, accept_events_from
         FROM \`${T}\`
        WHERE vendor = ? AND serial_number = ?
        LIMIT 1`,
      [identity.vendor, identity.serialNumber]
    );
    return rows?.[0] ?? null;
  }

  async upsertSafeUsers({ device, records, observedAt }) {
    const row = await this.get(device);
    if (!row) throw new Error('device must exist before device users can be stored');
    const users = extractSafeUsers(records);
    if (this.deviceUserIdentityEnabled) return this.#storeUnversionedUsers(row.id, users, observedAt);
    for (const user of users) {
      await this.pool.execute(
        `INSERT INTO \`${BIOMETRIC_TABLES.deviceUsers}\` (
           device_id, device_user_id, display_name, status, metadata_schema_version,
           safe_metadata, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, 'seen', 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           display_name = COALESCE(VALUES(display_name), display_name),
           status = CASE WHEN status = 'absent_from_device' THEN 'seen' ELSE status END,
           safe_metadata = COALESCE(VALUES(safe_metadata), safe_metadata),
           last_seen_at = VALUES(last_seen_at)`,
        [row.id, user.deviceUserId, user.displayName, jsonOrNull(user.metadata), observedAt, observedAt]
      );
    }
    return { deviceId: row.id, userCount: users.length };
  }

  async #storeUnversionedUsers(deviceId, users, observedAt) {
    if (!users.length) return { deviceId, userCount: 0 };
    const connection = await this.pool.getConnection();
    let userCount = 0;
    try {
      await connection.beginTransaction();
      await lockDeviceForUserIdentity(connection, deviceId);
      for (const user of users) {
        const identities = await listDeviceUserIdentities(connection, deviceId, user.deviceUserId);
        if (identities.length === 0) {
          await connection.execute(
            `INSERT INTO \`${USERS}\` (device_id, device_user_id, display_name, status,
               metadata_schema_version, safe_metadata, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, 'seen', 1, ?, ?, ?)`,
            [deviceId, user.deviceUserId, user.displayName, jsonOrNull(user.metadata), observedAt, observedAt]);
          userCount++;
          continue;
        }
        // USER carries a PIN and profile, but no reliable enrollment identity or revision.
        const [identity] = identities;
        if (identities.length !== 1 || identity.status === 'absent_from_device' || identity.identity_ended_at != null) continue;
        await connection.execute(
          `UPDATE \`${USERS}\`
              SET display_name = COALESCE(?, display_name), safe_metadata = COALESCE(?, safe_metadata),
                  last_seen_at = CASE WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ? ELSE last_seen_at END
            WHERE id = ? AND device_id = ? AND device_user_id = ?
              AND identity_ended_at IS NULL AND status <> 'absent_from_device'`,
          [user.displayName, jsonOrNull(user.metadata), observedAt, observedAt, identity.id, deviceId, user.deviceUserId]);
        userCount++;
      }
      await connection.commit();
      return { deviceId, userCount };
    } catch (error) {
      try { await connection.rollback(); } catch { /* Preserve the write failure. */ }
      throw error;
    } finally {
      connection.release();
    }
  }
}

function extractSafeUsers(records) {
  const output = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.kind !== 'device_user') continue;
    const fields = record.fields ?? {};
    const deviceUserId = safeText(fields.PIN);
    if (!deviceUserId) continue;
    const displayName = safeText(fields.Name);
    const metadata = {};
    for (const key of ['Pri', 'Grp', 'TZ', 'Verify', 'StartDatetime', 'EndDatetime']) {
      if (fields[key] != null) metadata[key] = fields[key];
    }
    output.push({ deviceUserId, displayName, metadata: Object.keys(metadata).length > 0 ? metadata : null });
  }
  return output;
}

function normalizeMetadata(metadata) {
  const value = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    displayName: safeText(value.displayName),
    manufacturer: safeText(value.manufacturer),
    model: safeText(value.model),
    protocol: safeText(value.protocol),
    adapterType: safeText(value.adapterType),
    firmwareVersion: safeText(value.firmwareVersion),
    platform: safeText(value.platform),
    oemVendor: safeText(value.oemVendor),
    safeCapabilities: value.safeCapabilities && typeof value.safeCapabilities === 'object'
      ? value.safeCapabilities
      : null
  };
}

function safeText(value) {
  if (value == null || Array.isArray(value)) return null;
  const text = String(value).trim();
  if (!text || text === '[REDACTED]' || text.startsWith('[OMITTED:')) return null;
  return text;
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}
