import { createHash, randomInt } from 'node:crypto';
import { createUserDirectoryPreview } from './user-directory-preview.js';

const responseWindowMs = 5 * 60 * 1000;
const configPattern = /^(zkteco:[A-Za-z0-9_-]{1,128}),([0-9]{1,14}),([a-f0-9]{64})$/;

export function createUserQueryProbe(setting, allowedDevices, directorySetting) {
  const singleUser = setting != null && setting !== '';
  const directory = directorySetting != null && directorySetting !== '';
  if (!singleUser && !directory) return null;
  const values = typeof setting === 'string' && configPattern.exec(setting);
  const deviceKey = directory ? directorySetting : values?.[1];
  if ((singleUser && directory) || !allowedDevices.includes(deviceKey)) throw new Error('Invalid user query probe configuration');
  const [, , pin, expectedNameHash] = values || [];
  const preview = directory ? createUserDirectoryPreview() : null;
  const commandId = String(randomInt(100000000, 1000000000));
  let sentAt = null;
  let commandAccepted = null;
  let matchObserved = false;

  const target = device => `${device.vendor}:${device.serialNumber}` === deviceKey;
  const withinWindow = device => target(device) && sentAt !== null && Date.now() - sentAt <= responseWindowMs;
  return Object.freeze({
    isDirectoryTarget(device) { return directory && target(device); },
    isDirectoryAwaitingUploads(device) { return directory && target(device) && (sentAt === null || withinWindow(device)); },
    takeCommand(device) {
      if (!target(device) || sentAt !== null) return null;
      sentAt = Date.now();
      preview?.start();
      return `C:${commandId}:DATA QUERY USERINFO${directory ? '' : ` PIN=${pin}`}\n`;
    },
    profilesForStorage(device, records) {
      // OPERLOG has no command ID. Keep the queried profiles out of storage
      // for this diagnostic deployment, including late replies.
      return target(device) && (directory || sentAt !== null)
        ? records.filter(record => record.kind !== 'device_user' || (!directory && record.fields.PIN !== pin))
        : records;
    },
    observeProfile(device, body, observation) {
      if (!withinWindow(device)) return null;
      if (preview) return preview.observe(body, observation);
      if (matchObserved || !observation.safeToAcknowledge || body.includes('\uFFFD')) return null;
      const profiles = body.split(/\r?\n/).map(line => line.trim()).filter(line => /^USER\s/.test(line));
      if (profiles.length !== 1) return null;
      const fields = [...profiles[0].matchAll(/(?:^|\s)(PIN|Name)=/g)].map(match => match[1]);
      if (fields.length !== 2 || !fields.includes('PIN') || !fields.includes('Name')) return null;
      const profile = observation.records.find(record => record.kind === 'device_user');
      if (profile?.fields.PIN !== pin) return null;
      const name = profile.fields.Name;
      const namePresent = typeof name === 'string' && name.length > 0 && !name.startsWith('[OMITTED:');
      matchObserved = namePresent && createHash('sha256').update(name).digest('hex') === expectedNameHash;
      return { type: 'user_query_probe_profile_observed', probeProfileCount: 1,
        probeNamePresent: Number(namePresent), probeNameMatches: Number(matchObserved) };
    },
    awaitsReply(device) { return withinWindow(device) && commandAccepted === null; },
    observeReply(device, body) {
      if (!withinWindow(device) || commandAccepted !== null || body.includes('\uFFFD')) return null;
      const params = new URLSearchParams(body.trim());
      if (params.getAll('ID').length !== 1 || params.get('ID') !== commandId ||
          params.getAll('CMD').length !== 1 || params.get('CMD') !== 'DATA' ||
          params.getAll('Return').length !== 1 || !/^-?\d{1,10}$/.test(params.get('Return'))) return null;
      const serials = params.getAll('SN');
      if (serials.length && (serials.length !== 1 || serials[0] !== device.serialNumber)) return null;
      commandAccepted = params.get('Return') === '0';
      return { type: 'user_query_probe_reply', probeAccepted: Number(commandAccepted) };
    },
    ...(preview && { directorySnapshot: () => preview.snapshot({ sentAt, commandAccepted, responseWindowMs }) })
  });
}
