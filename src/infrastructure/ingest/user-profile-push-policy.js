export function normalizeUserProfilePushDevices(devices, allowedDevices) {
  if (devices === undefined) return Object.freeze([]);
  if (!Array.isArray(devices) || devices.length > allowedDevices.length) {
    throw new Error('Invalid user profile push device list');
  }
  const selected = [...devices];
  if (new Set(selected).size !== selected.length || selected.some(device => !allowedDevices.includes(device))) {
    throw new Error('Invalid user profile push device list');
  }
  return Object.freeze(selected);
}
