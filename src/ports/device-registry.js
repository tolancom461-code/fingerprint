export class DeviceRegistry {
  isAllowed(_deviceIdentity) {
    throw new Error('Not implemented');
  }

  get(_deviceIdentity) {
    throw new Error('Not implemented');
  }

  count() {
    throw new Error('Not implemented');
  }
}
