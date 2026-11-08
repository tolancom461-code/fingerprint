export function createDeviceIdentity({ vendor, serialNumber }) {
  const normalizedVendor = String(vendor ?? '').trim().toLowerCase();
  const normalizedSerial = String(serialNumber ?? '').trim();

  if (!normalizedVendor) throw new Error('vendor is required');
  if (!normalizedSerial) throw new Error('serialNumber is required');

  return Object.freeze({
    vendor: normalizedVendor,
    serialNumber: normalizedSerial,
    key: `${normalizedVendor}:${normalizedSerial}`
  });
}
