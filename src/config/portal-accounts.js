import { validatePasswordHash } from '../infrastructure/portal/auth.js';

export function portalAccountsConfig({ origin, adminUsername, adminPasswordHash, viewerUsername, viewerPasswordHash }) {
  const users = [{ username: username(adminUsername), passwordHash: passwordHash(adminPasswordHash), role: 'admin' }];
  if (viewerUsername || viewerPasswordHash) {
    users.push({ username: username(viewerUsername), passwordHash: passwordHash(viewerPasswordHash), role: 'viewer' });
    if (users[0].username.toLowerCase() === users[1].username.toLowerCase()) {
      throw new Error('Admin and viewer usernames must be different');
    }
  }
  return Object.freeze({ origin: portalOrigin(origin), users: Object.freeze(users.map(user => Object.freeze(user))) });
}

function portalOrigin(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { throw new Error('A valid portal origin is required'); }
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
