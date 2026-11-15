import { randomInt } from 'node:crypto';
import { createUserDirectoryPreview } from './user-directory-preview.js';

const intervalMs = 5 * 60 * 1000;
const cycleTimeoutMs = 5 * 60 * 1000;
const quietMs = 15000;

export function createZktecoUserDirectorySync({ deviceKey, mode, onComplete, now = Date.now,
  commandId = () => String(randomInt(100000000, 1000000000)), write = async () => {} }) {
  const active = mode === 'active';
  let cycle;
  let nextAt = 0;
  let applying = false;

  const target = device => `${device.vendor}:${device.serialNumber}` === deviceKey;
  const log = (event, counts = {}) => write({ type: `user_directory_sync_${event}`, ...counts });
  const reset = () => { cycle = undefined; nextAt = now() + intervalMs; };
  const expired = () => cycle && now() >= cycle.deadline;
  const roster = () => cycle.preview.snapshot({ sentAt: cycle.rosterSentAt,
    commandAccepted: null, responseWindowMs: cycleTimeoutMs });

  return Object.freeze({
    ownsProfiles(device) { return active && target(device); },

    async takeCommand(device) {
      if (!target(device) || applying) return null;
      const timestamp = now();
      if (expired()) {
        reset();
        await log('timed_out');
        return null;
      }
      if (!cycle && timestamp >= nextAt) {
        const id = commandId();
        cycle = { phase: 'first_count', id, deadline: timestamp + cycleTimeoutMs };
        await log('count_requested');
        return `C:${id}:INFO\n`;
      }
      if (cycle?.phase === 'ready_for_roster') {
        const id = commandId();
        Object.assign(cycle, { phase: 'collecting', rosterCommand: id, rosterSentAt: timestamp,
          preview: createUserDirectoryPreview({ includeMetadata: true, now }) });
        await log('roster_requested');
        return `C:${id}:DATA QUERY USERINFO\n`;
      }
      if (cycle?.phase !== 'collecting') return null;
      const snapshot = roster();
      if (snapshot.invalidCount || snapshot.conflictingCount || snapshot.observedCount > cycle.count) {
        reset();
        await log('incomplete');
        return null;
      }
      const lastUploadAt = Date.parse(snapshot.lastUploadAt) || cycle.rosterSentAt;
      if (snapshot.observedCount !== cycle.count || timestamp - lastUploadAt < quietMs) return null;
      const id = commandId();
      Object.assign(cycle, { phase: 'last_count', id, checkedUploadAt: snapshot.lastUploadAt });
      await log('count_requested');
      return `C:${id}:INFO\n`;
    },

    awaitsReply(device) { return target(device) && Boolean(cycle) && !expired(); },

    observeProfile(device, body, observation) {
      if (!target(device) || expired() || !['collecting', 'last_count'].includes(cycle?.phase)) return;
      cycle.preview.observe(body, observation);
    },

    async observeReply(device, body) {
      if (!target(device) || !cycle || expired() || body.includes('\uFFFD')) return;
      const [header, ...lines] = body.trim().split(/\r?\n/);
      const params = new URLSearchParams(header);
      if (['ID', 'CMD', 'Return'].some(key => params.getAll(key).length !== 1) ||
          params.getAll('SN').length > 1 || (params.has('SN') && params.get('SN') !== device.serialNumber) ||
          !/^-?\d{1,10}$/.test(params.get('Return'))) return;
      if (params.get('ID') === cycle.rosterCommand && params.get('CMD') === 'DATA') {
        if (params.get('Return') !== '0') {
          reset();
          await log('incomplete');
        }
        return;
      }
      if (!['first_count', 'last_count'].includes(cycle.phase) || params.get('ID') !== cycle.id || params.get('CMD') !== 'INFO') return;
      const count = params.get('Return') === '0' ? readUserCount(lines) : null;
      if (count === null) {
        reset();
        await log('count_unavailable');
        return;
      }
      if (cycle.phase === 'first_count') {
        if (active) Object.assign(cycle, { phase: 'ready_for_roster', count });
        else reset();
        await log('count_verified', { recordCount: count });
        return;
      }
      const snapshot = roster();
      if (count !== cycle.count || snapshot.observedCount !== count || snapshot.invalidCount || snapshot.conflictingCount ||
          snapshot.lastUploadAt !== cycle.checkedUploadAt) {
        reset();
        await log('incomplete');
        return;
      }
      const observedAtUtc = snapshot.lastUploadAt ?? new Date(cycle.rosterSentAt).toISOString();
      reset();
      applying = true;
      try {
        const outcome = await onComplete({ device, userCount: count, observedAtUtc,
          profiles: snapshot.items.map(({ conflictingName: _conflict, ...profile }) => profile) });
        await log('reconciled', { recordCount: count, ...outcome });
      } catch {
        await log('store_failed');
      } finally {
        applying = false;
      }
    }
  });
}

function readUserCount(lines) {
  const fields = lines.join('\n').split(/[\r\n\t,]+/);
  const values = fields.map(field => /^\s*~*UserCount\s*=\s*(.*?)\s*$/i.exec(field)?.[1]).filter(value => value !== undefined);
  if (values.length !== 1 || !/^(?:0|[1-9]\d{0,4})$/.test(values[0])) return null;
  const count = Number(values[0]);
  return count <= 10000 ? count : null;
}
