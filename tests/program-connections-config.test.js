import test from 'node:test';
import assert from 'node:assert/strict';
import { programConnectionsConfig } from '../src/config/program-connections.js';
const streamId = '35d108c3-6b73-41b1-a4d6-e65dc4db3c74';
test('program connections are opt-in and can be disabled while preserving stream identity', () => {
  assert.equal(programConnectionsConfig({}), null);
  assert.equal(programConnectionsConfig({ BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'false', BIOMETRIC_INGEST_SOURCE_STREAM_ID: streamId }), null);
  assert.deepEqual(programConnectionsConfig({ BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'true', BIOMETRIC_INGEST_SOURCE_STREAM_ID: streamId }), { streamId });
});
test('enabled program connections require a real stable UUID and explicit flag', () => {
  for (const input of [
    { BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'true' },
    { BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'true', BIOMETRIC_INGEST_SOURCE_STREAM_ID: 'test' },
    { BIOMETRIC_INGEST_PROGRAM_CONNECTIONS_ENABLED: 'TRUE', BIOMETRIC_INGEST_SOURCE_STREAM_ID: streamId }
  ]) assert.throws(() => programConnectionsConfig(input), { code: 'CLOUD_INGEST_CONFIG_INVALID' });
});
