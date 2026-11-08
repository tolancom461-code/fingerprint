import { DeviceRegistry } from '../../ports/device-registry.js';
import { createDeviceIdentity } from '../../domain/device-identity.js';

export class EnvDeviceRegistry extends DeviceRegistry {
  constructor(allowedDevices = []) {
    super();
    this.devices = new Map();

    for (const entry of allowedDevices) {
      const device = normalizeEntry(entry);
      if (!device) continue;
      this.devices.set(device.key, device);
    }
  }

  isAllowed(deviceIdentity) {
    try {
      const identity = createDeviceIdentity(deviceIdentity);
      return this.devices.has(identity.key);
    } catch {
      return false;
    }
  }

  get(deviceIdentity) {
    try {
      const identity = createDeviceIdentity(deviceIdentity);
      return this.devices.get(identity.key) ?? null;
    } catch {
      return null;
    }
  }

  count() {
    return this.devices.size;
  }
}

function normalizeEntry(entry) {
  if (typeof entry === 'string') {
    const raw = entry.trim();
    if (!raw) return null;
    const separator = raw.indexOf(':');
    if (separator <= 0 || separator === raw.length - 1) {
      throw new Error(`Invalid biometric device entry: ${raw}. Expected vendor:serialNumber`);
    }
    return createDeviceIdentity({
      vendor: raw.slice(0, separator),
      serialNumber: raw.slice(separator + 1)
    });
  }

  if (entry && typeof entry === 'object') return createDeviceIdentity(entry);
  return null;
}
