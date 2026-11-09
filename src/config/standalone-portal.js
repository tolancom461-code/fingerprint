import { portalAccountsConfig } from './portal-accounts.js';

// This runtime never consumes the original application's or fixture's variables.
export function loadStandalonePortalConfig(env = process.env) {
  const host = env.BIOMETRIC_PORTAL_HOST ?? '0.0.0.0';
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw invalid();
  const dbHost = required(env, 'BIOMETRIC_PORTAL_DB_HOST');
  if (dbHost.length > 253 || !/^[A-Za-z0-9.:-]+$/.test(dbHost)) throw invalid();
  const database = env.BIOMETRIC_PORTAL_DB_NAME;
  const confirmedName = env.BIOMETRIC_PORTAL_DB_CONFIRMED_NAME;
  if (database !== 'fingerprint' || confirmedName !== 'fingerprint') throw invalid();
  const sslMode = env.BIOMETRIC_PORTAL_DB_SSL_MODE ?? 'required';
  if (!['required', 'disabled'].includes(sslMode) ||
      (sslMode === 'disabled' && !['127.0.0.1', 'localhost', '::1'].includes(dbHost))) throw invalid();
  const user = required(env, 'BIOMETRIC_PORTAL_DB_USER');
  if (user.length > 128 || /[\u0000-\u001f\u007f]/.test(user)) throw invalid();
  const password = env.BIOMETRIC_PORTAL_DB_PASSWORD;
  if (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024) throw invalid();
  let portal;
  try {
    portal = portalAccountsConfig({ origin: env.BIOMETRIC_PORTAL_ORIGIN,
      adminUsername: env.BIOMETRIC_PORTAL_ADMIN_USERNAME,
      adminPasswordHash: env.BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH,
      viewerUsername: env.BIOMETRIC_PORTAL_VIEWER_USERNAME,
      viewerPasswordHash: env.BIOMETRIC_PORTAL_VIEWER_PASSWORD_HASH });
  } catch { throw invalid(); }
  return Object.freeze({ host, port: integer(env.PORT, 8080, 1, 65535), portal,
    database: Object.freeze({ profile: 'standalone-readonly', host: dbHost,
      port: integer(env.BIOMETRIC_PORTAL_DB_PORT, 4000, 1, 65535), user, password,
      database, confirmedName, sslMode, connectionLimit: 3,
      connectTimeoutMs: integer(env.BIOMETRIC_PORTAL_DB_CONNECT_TIMEOUT_MS, 6000, 100, 10000),
      queryTimeoutMs: integer(env.BIOMETRIC_PORTAL_DB_QUERY_TIMEOUT_MS, 5000, 100, 10000) }) });
}

function required(env, key) {
  if (typeof env[key] !== 'string' || !env[key].trim()) throw invalid();
  return env[key].trim();
}

function integer(raw, fallback, minimum, maximum) {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) throw invalid();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}

function invalid() {
  return Object.assign(new Error('Invalid standalone read-only portal configuration'), { code: 'STANDALONE_PORTAL_CONFIG_INVALID' });
}
