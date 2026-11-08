// Vendor/device interpretation profiles.
// Numeric Status/Verify mappings are NOT assumed across all ZKTeco devices.
// The profile below is limited to the exact terminal/firmware proven by real-device tests.
const DEVICE_PROFILES = Object.freeze({
  AJE1261900133: Object.freeze({
    profileId: 'speedface-v5l-zam230-aje1261900133-v1',
    punchStateByRawStatus: Object.freeze({
      '0': 'check_in',
      '1': 'check_out',
      '2': 'break_out',
      '3': 'break_in',
      '4': 'overtime_in',
      '5': 'overtime_out'
    }),
    verificationMethodByRawVerify: Object.freeze({
      '1': 'fingerprint',
      '3': 'password',
      '4': 'card',
      '15': 'face',
      '25': 'palm'
    })
  })
});

export function normalizeZktecoAttendance({ serialNumber, rawStatus, rawVerify }) {
  const profile = DEVICE_PROFILES[String(serialNumber ?? '')];
  if (!profile) {
    return Object.freeze({
      profileId: null,
      punchState: null,
      verificationMethod: null
    });
  }

  return Object.freeze({
    profileId: profile.profileId,
    punchState: rawStatus == null ? null : (profile.punchStateByRawStatus[String(rawStatus)] ?? null),
    verificationMethod: rawVerify == null ? null : (profile.verificationMethodByRawVerify[String(rawVerify)] ?? null)
  });
}
