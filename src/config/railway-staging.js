import path from 'node:path';

const STAGING_DIRECTORY = 'railway-staging';

// Read only the infrastructure settings named here. Production database
// credentials and connector settings are never inspected by this launcher.
export function railwayStagingEnvironment(env, serviceRoot) {
  const root = path.resolve(serviceRoot);
  const port = stagingPort(env.PORT);
  const customParent = optionalPath(env.BIOMETRIC_STAGING_DATA_DIR);
  const volume = optionalPath(env.RAILWAY_VOLUME_MOUNT_PATH);
  let parent;

  if (customParent) {
    parent = path.resolve(root, customParent);
    if (!path.isAbsolute(customParent) && !isContained(root, parent)) {
      throw new Error('Relative BIOMETRIC_STAGING_DATA_DIR must stay inside the service directory');
    }
  } else if (volume) {
    if (!path.isAbsolute(volume)) throw new Error('RAILWAY_VOLUME_MOUNT_PATH must be absolute');
    parent = path.resolve(volume);
  } else {
    parent = path.join(root, 'var');
  }

  // Always append a dedicated directory, including when the operator supplies
  // a parent directory. Never reuse inherited capture/log/cursor locations.
  const dataRoot = path.join(parent, STAGING_DIRECTORY);
  const captures = path.join(dataRoot, 'captures');
  const logs = path.join(dataRoot, 'logs');
  const state = path.join(dataRoot, 'web-bridge-state.json');
  if (![captures, logs, state].every(value => isContained(dataRoot, value))) {
    throw new Error('Staging paths must stay inside the dedicated data directory');
  }

  return Object.freeze({
    PORT: String(port),
    BIOMETRIC_HOST: '0.0.0.0',
    BIOMETRIC_PORT: String(port),
    BIOMETRIC_STORAGE_MODE: 'file',
    BIOMETRIC_ALLOWED_DEVICES: '',
    BIOMETRIC_ALLOWED_SERIALS: '',
    BIOMETRIC_ATTLOG_ACK_MODE: 'observe',
    BIOMETRIC_ACK_MODE: 'observe',
    BIOMETRIC_ADMIN_ENABLED: 'false',
    BIOMETRIC_ADMIN_HOST: '127.0.0.1',
    BIOMETRIC_ADMIN_PORT: '9096',
    BIOMETRIC_FINAL_EVENTS_API_ENABLED: 'false',
    BIOMETRIC_FINAL_EVENTS_API_HOST: '127.0.0.1',
    BIOMETRIC_FINAL_EVENTS_API_PORT: '9097',
    BIOMETRIC_WEB_BRIDGE_ENABLED: 'false',
    BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'false',
    BIOMETRIC_CAPTURE_DIR: captures,
    BIOMETRIC_LOG_DIR: logs,
    BIOMETRIC_WEB_BRIDGE_STATE_FILE: state,
    BIOMETRIC_LOG_TIMEZONE: 'Asia/Riyadh',
    BIOMETRIC_LOG_MAX_BYTES: '10485760',
    BIOMETRIC_LOG_RETAIN_FILES: '5',
    BIOMETRIC_MAX_BODY_BYTES: '524288',
    BIOMETRIC_ADMS_DELAY_SECONDS: '10',
    BIOMETRIC_ADMS_ERROR_DELAY_SECONDS: '60',
    BIOMETRIC_ADMS_REALTIME: '1',
    BIOMETRIC_ADMS_ENCRYPT: '0'
  });
}

function stagingPort(raw) {
  const text = raw == null || raw === '' ? '8080' : raw;
  if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) {
    throw new Error('PORT must be a complete decimal integer between 1 and 65535');
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error('PORT must be a complete decimal integer between 1 and 65535');
  }
  return value;
}

function optionalPath(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw new Error('Staging data path must be a nonempty path');
  }
  return raw;
}

function isContained(parent, value) {
  const relative = path.relative(parent, value);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
