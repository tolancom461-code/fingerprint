import { validatePasswordHash } from '../infrastructure/portal/auth.js';

export function stagingPortalConfig(env, runtime) {
  const raw = String(env.BIOMETRIC_STAGING_PORTAL_ENABLED ?? '').trim().toLowerCase();
  if (['', 'false', '0', 'off', 'no'].includes(raw)) return null;
  if (!['true', '1', 'on', 'yes'].includes(raw)) throw new Error('Invalid BIOMETRIC_STAGING_PORTAL_ENABLED');
  if (runtime.storageMode !== 'file' || runtime.allowedDevices.length !== 0 ||
      runtime.admin.enabled || runtime.finalEventsApi.enabled || runtime.webBridge.enabled || runtime.autoFinalizeNewPunches) {
    throw new Error('The demo portal requires isolated staging with all devices and production connections disabled');
  }
  const origin = portalOrigin(env.BIOMETRIC_STAGING_PORTAL_ORIGIN);
  const users = [{
    username: username(env.BIOMETRIC_STAGING_ADMIN_USERNAME),
    passwordHash: passwordHash(env.BIOMETRIC_STAGING_ADMIN_PASSWORD_HASH),
    role: 'admin'
  }];
  const viewerName = env.BIOMETRIC_STAGING_VIEWER_USERNAME;
  const viewerHash = env.BIOMETRIC_STAGING_VIEWER_PASSWORD_HASH;
  if (viewerName || viewerHash) {
    users.push({ username: username(viewerName), passwordHash: passwordHash(viewerHash), role: 'viewer' });
    if (users[0].username.toLowerCase() === users[1].username.toLowerCase()) {
      throw new Error('Admin and viewer usernames must be different');
    }
  }
  return Object.freeze({ origin, users: Object.freeze(users.map(user => Object.freeze(user))) });
}

function portalOrigin(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { throw new Error('A valid BIOMETRIC_STAGING_PORTAL_ORIGIN is required'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Portal origin must be an HTTPS origin without a path; HTTP is allowed only on loopback for testing');
  }
  return url.origin;
}

function username(raw) {
  const value = String(raw ?? '').trim();
  if (!/^[a-zA-Z0-9_.@-]{3,80}$/.test(value)) throw new Error('A portal username of 3 to 80 letters, digits or . _ @ - is required');
  return value;
}

function passwordHash(raw) {
  if (typeof raw !== 'string' || !validatePasswordHash(raw)) {
    throw new Error('A valid portal password hash is required; generate it with npm run admin:password-hash');
  }
  return raw;
}
