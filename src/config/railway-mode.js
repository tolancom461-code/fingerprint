export function railwayMode(env = process.env) {
  const mode = env.BIOMETRIC_RAILWAY_MODE ?? 'demo';
  if (!['demo', 'database-readonly', 'database-ingest'].includes(mode)) {
    throw Object.assign(new Error('Invalid Railway runtime mode'), { code: 'RAILWAY_MODE_INVALID' });
  }
  return mode;
}
