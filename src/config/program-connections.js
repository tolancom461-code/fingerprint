export function programConnectionsConfig(env) {
  const enabled = env.BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED;
  const streamId = env.BIOMETRIC_INGEST_SOURCE_STREAM_ID;
  // Keep the stream identifier during a temporary disable so re-enabling cannot change receipt identities.
  if (enabled === undefined || enabled === 'false') return null;
  if (enabled !== 'true' || typeof streamId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(streamId)) {
    throw Object.assign(new Error('Invalid program connections configuration'), { code: 'CLOUD_INGEST_CONFIG_INVALID' });
  }
  return Object.freeze({ streamId });
}
