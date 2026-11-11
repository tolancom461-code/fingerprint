import { portalAccountsConfig } from './portal-accounts.js';
import { normalizeBasicMachineCredentials } from '../infrastructure/ingest/basic-machine-credentials.js';
import { normalizeConsumerApiConfig } from '../infrastructure/integration/consumer-api-credentials.js';

export function loadCloudIngestConfig(env = process.env) {
  const host = env.BIOMETRIC_INGEST_HOST ?? '0.0.0.0';
  if (!['0.0.0.0', '127.0.0.1', '::1'].includes(host)) throw invalid();
  const databaseHost = required(env, 'BIOMETRIC_INGEST_DB_HOST');
  if (databaseHost.length > 253 || !/^[A-Za-z0-9.:-]+$/.test(databaseHost)) throw invalid();
  if (env.BIOMETRIC_INGEST_DB_NAME !== 'fingerprint' || env.BIOMETRIC_INGEST_DB_CONFIRMED_NAME !== 'fingerprint') throw invalid();
  const sslMode = env.BIOMETRIC_INGEST_DB_SSL_MODE ?? 'required';
  if (!['required', 'disabled'].includes(sslMode) ||
      (sslMode === 'disabled' && !['127.0.0.1', 'localhost', '::1'].includes(databaseHost))) throw invalid();
  const user = required(env, 'BIOMETRIC_INGEST_DB_USER');
  const password = env.BIOMETRIC_INGEST_DB_PASSWORD;
  if (user.length > 128 || /[\u0000-\u001f\u007f]/.test(user) || /(?:^|\.)root$/i.test(user) ||
      typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 1024) throw invalid();
  const token = env.BIOMETRIC_INGEST_TOKEN;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw invalid();
  const allowedDevices = required(env, 'BIOMETRIC_INGEST_ALLOWED_DEVICES').split(',');
  if (allowedDevices.length > 100 || allowedDevices.some(value => !/^zkteco:[A-Za-z0-9_-]{1,128}$/.test(value)) ||
      new Set(allowedDevices).size !== allowedDevices.length) throw invalid();
  // Finalization is a later, deliberate activation after history reconciliation.
  if (env.BIOMETRIC_INGEST_AUTO_FINALIZE_NEW_PUNCHES !== undefined && env.BIOMETRIC_INGEST_AUTO_FINALIZE_NEW_PUNCHES !== 'false') throw invalid();
  let portal;
  let basicCredentials = null;
  let consumerApi;
  try {
    if (Object.hasOwn(env, 'BIOMETRIC_INGEST_BASIC_USERNAME') || Object.hasOwn(env, 'BIOMETRIC_INGEST_BASIC_PASSWORD')) {
      basicCredentials = normalizeBasicMachineCredentials({
        username: env.BIOMETRIC_INGEST_BASIC_USERNAME,
        password: env.BIOMETRIC_INGEST_BASIC_PASSWORD
      });
    }
    portal = portalAccountsConfig({ origin: env.BIOMETRIC_PORTAL_ORIGIN,
      adminUsername: env.BIOMETRIC_PORTAL_ADMIN_USERNAME,
      adminPasswordHash: env.BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH,
      viewerUsername: env.BIOMETRIC_PORTAL_VIEWER_USERNAME,
      viewerPasswordHash: env.BIOMETRIC_PORTAL_VIEWER_PASSWORD_HASH });
    consumerApi = consumerApiConfig(env, token, basicCredentials?.password);
  } catch { throw invalid(); }
  return Object.freeze({ host, port: integer(env.PORT, 8080, 1, 65535), portal,
    token, basicCredentials, consumerApi, allowedDevices: Object.freeze(allowedDevices),
    maxBodyBytes: integer(env.BIOMETRIC_INGEST_MAX_BODY_BYTES, 524288, 1024, 524288),
    autoFinalizeNewPunches: false,
    retrySweepSeconds: integer(env.BIOMETRIC_INGEST_RETRY_SWEEP_SECONDS, 2, 1, 3600),
    retryDelaySeconds: integer(env.BIOMETRIC_INGEST_RETRY_DELAY_SECONDS, 2, 1, 3600),
    replayLimit: integer(env.BIOMETRIC_INGEST_REPLAY_LIMIT, 1000, 1, 10000),
    adms: Object.freeze({ delaySeconds: 10, errorDelaySeconds: 60, realtime: 1, encrypt: 0 }),
    database: Object.freeze({ host: databaseHost, port: integer(env.BIOMETRIC_INGEST_DB_PORT, 4000, 1, 65535),
      user, password, database: 'fingerprint', confirmedName: 'fingerprint', sslMode, connectionLimit: 5,
      connectTimeoutMs: integer(env.BIOMETRIC_INGEST_DB_CONNECT_TIMEOUT_MS, 6000, 100, 10000),
      queryTimeoutMs: integer(env.BIOMETRIC_INGEST_DB_QUERY_TIMEOUT_MS, 5000, 100, 10000),
      transactionTimeoutMs: integer(env.BIOMETRIC_INGEST_DB_TRANSACTION_TIMEOUT_MS, 15000, 1000, 30000) }) });
}

function consumerApiConfig(env, ingestToken, basicPassword) {
  const hasEnabled = Object.hasOwn(env, 'BIOMETRIC_INGEST_CONSUMER_API_ENABLED');
  const hasToken = Object.hasOwn(env, 'BIOMETRIC_INGEST_CONSUMER_API_TOKEN');
  if (!hasEnabled && !hasToken) return null;
  const enabled = env.BIOMETRIC_INGEST_CONSUMER_API_ENABLED;
  if (enabled === 'false' && !hasToken) return null;
  if (!hasEnabled || enabled !== 'true' || !hasToken) throw invalid();
  return normalizeConsumerApiConfig({ token: env.BIOMETRIC_INGEST_CONSUMER_API_TOKEN }, { ingestToken, basicPassword });
}

function required(env, name) {
  if (typeof env[name] !== 'string' || !env[name].trim()) throw invalid();
  return env[name].trim();
}
function integer(raw, fallback, min, max) {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) throw invalid();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}
function invalid() { return Object.assign(new Error('Invalid cloud ingest configuration'), { code: 'CLOUD_INGEST_CONFIG_INVALID' }); }
