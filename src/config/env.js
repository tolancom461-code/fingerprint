import path from 'node:path';

function integer(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}


function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function list(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function allowedDevices() {
  const qualified = list('BIOMETRIC_ALLOWED_DEVICES');
  if (qualified.length > 0) return qualified;
  return list('BIOMETRIC_ALLOWED_SERIALS').map((serial) => `zkteco:${serial}`);
}

function attlogAckMode() {
  const raw = process.env.BIOMETRIC_ATTLOG_ACK_MODE ?? process.env.BIOMETRIC_ACK_MODE ?? 'observe';
  const value = raw.trim().toLowerCase();
  if (!['observe', 'ack'].includes(value)) {
    throw new Error('BIOMETRIC_ATTLOG_ACK_MODE must be observe or ack');
  }
  return value;
}

function storageMode() {
  const value = (process.env.BIOMETRIC_STORAGE_MODE || 'database').trim().toLowerCase();
  if (!['database', 'file'].includes(value)) {
    throw new Error('BIOMETRIC_STORAGE_MODE must be database or file');
  }
  return value;
}

function databaseConfig(mode) {
  if (mode !== 'database') return null;
  const host = required('BIOMETRIC_DB_HOST');
  const user = required('BIOMETRIC_DB_USER');
  const password = required('BIOMETRIC_DB_PASSWORD');
  const database = process.env.BIOMETRIC_DB_NAME?.trim() || 'test';
  const sslMode = (process.env.BIOMETRIC_DB_SSL_MODE || 'required').trim().toLowerCase();
  if (!['required', 'disabled'].includes(sslMode)) {
    throw new Error('BIOMETRIC_DB_SSL_MODE must be required or disabled');
  }

  return Object.freeze({
    host,
    port: integer('BIOMETRIC_DB_PORT', 4000, { min: 1, max: 65535 }),
    user,
    password,
    database,
    sslMode,
    connectionLimit: integer('BIOMETRIC_DB_CONNECTION_LIMIT', 5, { min: 1, max: 50 }),
    replayLimit: integer('BIOMETRIC_DB_REPLAY_LIMIT', 1000, { min: 1, max: 10000 }),
    retryDelaySeconds: integer('BIOMETRIC_DB_RETRY_DELAY_SECONDS', 30, { min: 1, max: 3600 }),
    retrySweepSeconds: integer('BIOMETRIC_DB_RETRY_SWEEP_SECONDS', 10, { min: 1, max: 3600 })
  });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when BIOMETRIC_STORAGE_MODE=database`);
  return value;
}


function finalEventsApiConfig(mode) {
  const enabled = mode === 'database' ? boolean('BIOMETRIC_FINAL_EVENTS_API_ENABLED', false) : false;
  const host = (process.env.BIOMETRIC_FINAL_EVENTS_API_HOST || '127.0.0.1').trim();
  if (enabled && !['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase())) {
    throw new Error('BIOMETRIC_FINAL_EVENTS_API_HOST must remain loopback-only in this release');
  }

  let token = null;
  if (enabled) {
    token = String(process.env.BIOMETRIC_FINAL_EVENTS_API_TOKEN ?? '').trim();
    if (token.length < 32) {
      throw new Error('BIOMETRIC_FINAL_EVENTS_API_TOKEN must be at least 32 characters when the Final Events API is enabled');
    }
  }

  return Object.freeze({
    enabled,
    host,
    port: integer('BIOMETRIC_FINAL_EVENTS_API_PORT', 9097, { min: 1, max: 65535 }),
    token
  });
}


function webBridgeConfig(mode, cwd) {
  const enabled = mode === 'database' ? boolean('BIOMETRIC_WEB_BRIDGE_ENABLED', false) : false;
  if (!enabled) {
    return Object.freeze({ enabled: false });
  }

  const rawTarget = String(process.env.BIOMETRIC_WEB_BRIDGE_TARGET_URL ?? '').trim();
  if (!rawTarget) throw new Error('BIOMETRIC_WEB_BRIDGE_TARGET_URL is required when the web bridge is enabled');
  let baseUrl;
  try {
    baseUrl = new URL(rawTarget);
  } catch {
    throw new Error('BIOMETRIC_WEB_BRIDGE_TARGET_URL must be a valid URL');
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && localHosts.has(baseUrl.hostname.toLowerCase()))) {
    throw new Error('BIOMETRIC_WEB_BRIDGE_TARGET_URL must use HTTPS except for localhost testing');
  }

  const token = String(process.env.BIOMETRIC_WEB_BRIDGE_TOKEN ?? '').trim();
  if (token.length < 32) throw new Error('BIOMETRIC_WEB_BRIDGE_TOKEN must be at least 32 characters');

  const endpoint = new URL('/api/biometric-bridge/v1/final-events', baseUrl);
  return Object.freeze({
    enabled: true,
    targetUrl: endpoint.toString(),
    token,
    intervalSeconds: integer('BIOMETRIC_WEB_BRIDGE_INTERVAL_SECONDS', 10, { min: 5, max: 3600 }),
    requestTimeoutSeconds: integer('BIOMETRIC_WEB_BRIDGE_REQUEST_TIMEOUT_SECONDS', 10, { min: 3, max: 120 }),
    stateFile: path.resolve(cwd, process.env.BIOMETRIC_WEB_BRIDGE_STATE_FILE || './var/web-bridge-state.json')
  });
}

function adminConfig(mode) {
  const enabled = mode === 'database' ? boolean('BIOMETRIC_ADMIN_ENABLED', true) : false;
  const host = (process.env.BIOMETRIC_ADMIN_HOST || '127.0.0.1').trim();
  if (enabled && !['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase())) {
    throw new Error('BIOMETRIC_ADMIN_HOST must remain loopback-only in this release');
  }
  return Object.freeze({
    enabled,
    host,
    port: integer('BIOMETRIC_ADMIN_PORT', 9096, { min: 1, max: 65535 })
  });
}

export function loadConfig(cwd = process.cwd()) {
  const mode = storageMode();
  return Object.freeze({
    host: process.env.BIOMETRIC_HOST || '0.0.0.0',
    port: integer('BIOMETRIC_PORT', 9095, { min: 1, max: 65535 }),
    allowedDevices: Object.freeze(allowedDevices()),
    storageMode: mode,
    database: databaseConfig(mode),
    admin: adminConfig(mode),
    finalEventsApi: finalEventsApiConfig(mode),
    webBridge: webBridgeConfig(mode, cwd),
    autoFinalizeNewPunches: mode === 'database' ? boolean('BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES', true) : false,
    captureDir: path.resolve(cwd, process.env.BIOMETRIC_CAPTURE_DIR || './var/captures'),
    logDir: path.resolve(cwd, process.env.BIOMETRIC_LOG_DIR || './var/logs'),
    logMaxBytes: integer('BIOMETRIC_LOG_MAX_BYTES', 10 * 1024 * 1024, { min: 64 * 1024, max: 1024 * 1024 * 1024 }),
    logRetainFiles: integer('BIOMETRIC_LOG_RETAIN_FILES', 5, { min: 1, max: 20 }),
    logTimezone: process.env.BIOMETRIC_LOG_TIMEZONE?.trim() || 'Asia/Riyadh',
    attlogAckMode: attlogAckMode(),
    maxBodyBytes: integer('BIOMETRIC_MAX_BODY_BYTES', 512 * 1024, { min: 1024, max: 10 * 1024 * 1024 }),
    zkteco: Object.freeze({
      adms: Object.freeze({
        delaySeconds: integer('BIOMETRIC_ADMS_DELAY_SECONDS', 10, { min: 1, max: 3600 }),
        errorDelaySeconds: integer('BIOMETRIC_ADMS_ERROR_DELAY_SECONDS', 60, { min: 1, max: 86400 }),
        realtime: integer('BIOMETRIC_ADMS_REALTIME', 1, { min: 0, max: 1 }),
        encrypt: integer('BIOMETRIC_ADMS_ENCRYPT', 0, { min: 0, max: 1 })
      })
    })
  });
}
