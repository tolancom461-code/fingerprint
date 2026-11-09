import { portalAccountsConfig } from './portal-accounts.js';

export function stagingPortalConfig(env, runtime) {
  const raw = String(env.BIOMETRIC_STAGING_PORTAL_ENABLED ?? '').trim().toLowerCase();
  if (['', 'false', '0', 'off', 'no'].includes(raw)) return null;
  if (!['true', '1', 'on', 'yes'].includes(raw)) throw new Error('Invalid BIOMETRIC_STAGING_PORTAL_ENABLED');
  if (runtime.storageMode !== 'file' || runtime.allowedDevices.length !== 0 ||
      runtime.admin.enabled || runtime.finalEventsApi.enabled || runtime.webBridge.enabled || runtime.autoFinalizeNewPunches) {
    throw new Error('The demo portal requires isolated staging with all devices and production connections disabled');
  }
  return portalAccountsConfig({
    origin: env.BIOMETRIC_STAGING_PORTAL_ORIGIN,
    adminUsername: env.BIOMETRIC_STAGING_ADMIN_USERNAME,
    adminPasswordHash: env.BIOMETRIC_STAGING_ADMIN_PASSWORD_HASH,
    viewerUsername: env.BIOMETRIC_STAGING_VIEWER_USERNAME,
    viewerPasswordHash: env.BIOMETRIC_STAGING_VIEWER_PASSWORD_HASH
  });
}
