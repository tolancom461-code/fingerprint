const maxUsers = 10000;
const previewRetentionMs = 30 * 60 * 1000;

const metadataKeys = ['Pri', 'Grp', 'TZ', 'Verify', 'StartDatetime', 'EndDatetime'];

export function createUserDirectoryPreview({ includeMetadata = false, now = Date.now } = {}) {
  const profiles = new Map();
  const conflicts = new Set();
  let invalidCount = 0;
  let lastUploadAt = null;

  return Object.freeze({
    start() {
      setTimeout(() => { profiles.clear(); conflicts.clear(); }, previewRetentionMs).unref();
    },
    observe(body, observation) {
      const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const userCount = observation.records.filter(record => record.kind === 'device_user').length;
      if (userCount === 0) return null;
      lastUploadAt = now();
      invalidCount += observation.unrecognizedCount;
      for (const [index, record] of observation.records.entries()) {
        if (record.kind !== 'device_user') continue;
        const profile = readProfile(lines[index], record.fields);
        if (!profile || (profiles.size >= maxUsers && !profiles.has(profile.deviceUserId))) {
          invalidCount++;
          continue;
        }
        const { deviceUserId, displayName } = profile;
        const projected = includeMetadata ? { displayName, nameReported: Object.hasOwn(record.fields, 'Name'),
          metadata: Object.fromEntries(metadataKeys.flatMap(key => {
            const value = record.fields[key];
            return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) &&
              !value.startsWith('[OMITTED:') && value !== '[REDACTED]' ? [[key, value]] : [];
          })) } : { displayName };
        if (!profiles.has(deviceUserId)) profiles.set(deviceUserId, projected);
        else if (JSON.stringify(profiles.get(deviceUserId)) !== JSON.stringify(projected)) conflicts.add(deviceUserId);
      }
      return { type: 'user_directory_preview_profiles', probeProfileCount: profiles.size };
    },
    snapshot({ sentAt, commandAccepted, responseWindowMs }) {
      const age = sentAt == null ? 0 : now() - sentAt;
      const expired = age >= previewRetentionMs;
      if (expired) { profiles.clear(); conflicts.clear(); }
      const items = Array.from(profiles, ([deviceUserId, profile]) => ({
        deviceUserId, ...profile, displayName: conflicts.has(deviceUserId) ? null : profile.displayName,
        conflictingName: conflicts.has(deviceUserId)
      }));
      let state = 'waiting_for_device';
      if (expired) state = 'expired';
      else if (sentAt != null) state = age >= responseWindowMs ? 'observation_window_ended' : 'collecting';
      return {
        state, commandAccepted, observedCount: items.length,
        namedCount: items.filter(item => item.displayName).length,
        conflictingCount: conflicts.size, invalidCount,
        requestedAt: sentAt == null ? null : new Date(sentAt).toISOString(),
        lastUploadAt: lastUploadAt == null ? null : new Date(lastUploadAt).toISOString(),
        items
      };
    }
  });
}

function readProfile(line, fields) {
  if (line == null || line.includes('\uFFFD')) return null;
  const keys = [...line.matchAll(/(?:^|\s)(PIN|Name)=/g)].map(match => match[1]);
  if (keys.filter(key => key === 'PIN').length !== 1 || keys.filter(key => key === 'Name').length > 1 ||
      !/^[0-9]{1,14}$/.test(fields.PIN ?? '')) return null;
  const name = fields.Name;
  if (name && (/[\u0000-\u001f\u007f]/.test(name) || name.startsWith('[OMITTED:'))) return null;
  return { deviceUserId: fields.PIN, displayName: name || null };
}
