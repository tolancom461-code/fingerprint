import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { hashPassword } from '../src/infrastructure/portal/auth.js';
import { prepareNativeBasicDeployment } from '../scripts/prepare-native-basic-deployment.mjs';

const hash = await hashPassword('Synthetic-only-portal-password-2026!');
const sourceName = '.env.railway.ingest.complete.tidb';
const railwayName = '.env.railway.ingest.basic.complete.tidb';
const deviceName = '.env.device-basic.tidb';
const source = { NODE_ENV: 'production', PORT: '8080', BIOMETRIC_RAILWAY_MODE: 'database-ingest',
  BIOMETRIC_INGEST_DB_HOST: 'database.example.invalid', BIOMETRIC_INGEST_DB_NAME: 'fingerprint',
  BIOMETRIC_INGEST_DB_CONFIRMED_NAME: 'fingerprint', BIOMETRIC_INGEST_DB_USER: 'synthetic.writer',
  BIOMETRIC_INGEST_DB_PASSWORD: 'SYNTHETIC_ONLY_DB_PASSWORD', BIOMETRIC_INGEST_TOKEN: 'x'.repeat(64),
  BIOMETRIC_INGEST_ALLOWED_DEVICES: 'zkteco:SYNTHETIC-DEVICE', BIOMETRIC_PORTAL_ORIGIN: 'https://device.example.invalid',
  BIOMETRIC_STAGING_PORTAL_ORIGIN: 'https://old.example.invalid', BIOMETRIC_PORTAL_ADMIN_USERNAME: 'synthetic-admin',
  BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH: hash, BIOMETRIC_INGEST_AUTO_FINALIZE_NEW_PUNCHES: 'false',
  DATABASE_URL: 'SYNTHETIC_OBSOLETE_ROOT_URL' };
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-basic-preparation-'));
  t.after(async () => {
    // Remove only these known files, then the now-empty owned directory.
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('native-basic-preparation-'));
    for (const name of ['package.json', sourceName, railwayName, deviceName]) {
      await fs.unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await fs.rmdir(directory);
  });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'tolan-biometric-service' }));
  const input = { ...source, ...overrides };
  await fs.writeFile(path.join(directory, sourceName), Object.entries(input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n'));
  return directory;
}

test('deployment preparation keeps connection settings, emits a separate random device key and reuses it without rotation', async t => {
  const directory = await fixture(t);
  const first = await prepareNativeBasicDeployment({ directory });
  assert.equal(first.passed, true);
  assert.equal(first.reused, false);
  const before = await fs.readFile(path.join(directory, railwayName), 'utf8');
  const env = parseEnv(before);
  const device = parseEnv(await fs.readFile(path.join(directory, deviceName), 'utf8'));
  assert.match(env.BIOMETRIC_INGEST_BASIC_PASSWORD, /^[0-9a-f]{32}$/);
  assert.equal(env.BIOMETRIC_INGEST_BASIC_USERNAME, 'zk');
  assert.equal(env.BIOMETRIC_INGEST_DB_PASSWORD, source.BIOMETRIC_INGEST_DB_PASSWORD);
  assert.equal(env.BIOMETRIC_PORTAL_ADMIN_PASSWORD_HASH, hash);
  assert.equal(env.BIOMETRIC_STAGING_PORTAL_ORIGIN, env.BIOMETRIC_PORTAL_ORIGIN);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(device.DEVICE_BASIC_PASSWORD, env.BIOMETRIC_INGEST_BASIC_PASSWORD);
  assert.equal(device.DEVICE_SERVER_ADDRESS,
    `https://zk:${env.BIOMETRIC_INGEST_BASIC_PASSWORD}@device.example.invalid:443`);
  assert.equal(JSON.stringify(first).includes(env.BIOMETRIC_INGEST_BASIC_PASSWORD), false);
  assert.equal(JSON.stringify(first).includes(source.BIOMETRIC_INGEST_DB_PASSWORD), false);
  const second = await prepareNativeBasicDeployment({ directory });
  assert.equal(second.reused, true);
  assert.equal(await fs.readFile(path.join(directory, railwayName), 'utf8'), before);
});

test('an incomplete or mismatched private pair is preserved and never silently replaced', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, railwayName), 'SYNTHETIC_PARTIAL_CONTENT');
  await assert.rejects(prepareNativeBasicDeployment({ directory }), { code: 'NATIVE_BASIC_PREPARATION_INVALID' });
  assert.equal(await fs.readFile(path.join(directory, railwayName), 'utf8'), 'SYNTHETIC_PARTIAL_CONTENT');
  await fs.unlink(path.join(directory, railwayName));
  await prepareNativeBasicDeployment({ directory });
  const before = await fs.readFile(path.join(directory, railwayName), 'utf8');
  await fs.writeFile(path.join(directory, deviceName), 'DEVICE_SERVER_ADDRESS="SYNTHETIC_WRONG_URL"');
  await assert.rejects(prepareNativeBasicDeployment({ directory }), { code: 'NATIVE_BASIC_PREPARATION_INVALID' });
  assert.equal(await fs.readFile(path.join(directory, railwayName), 'utf8'), before);
});

test('dotenv output preserves a backslash and embedded double quote in an existing database password', async t => {
  const directory = await fixture(t);
  const secret = 'SYNTHETIC-"quoted"-' + String.fromCharCode(92) + 'path';
  // Independently encode the source as a literal single-quoted dotenv value.
  await fs.appendFile(path.join(directory, sourceName), `\nBIOMETRIC_INGEST_DB_PASSWORD='${secret}'\n`);
  await prepareNativeBasicDeployment({ directory });
  const generated = parseEnv(await fs.readFile(path.join(directory, railwayName), 'utf8'));
  assert.equal(generated.BIOMETRIC_INGEST_DB_PASSWORD, secret);
});

test('preparation rejects source-credential inputs and insecure origins before creating credential outputs', async t => {
  for (const overrides of [{ TIDB_SOURCE_PASSWORD: 'SYNTHETIC_SOURCE_SECRET' },
    { BIOMETRIC_PORTAL_ORIGIN: 'http://127.0.0.1:8080' }]) {
    const directory = await fixture(t, overrides);
    await assert.rejects(prepareNativeBasicDeployment({ directory }));
    await assert.rejects(fs.access(path.join(directory, railwayName)), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(directory, deviceName)), { code: 'ENOENT' });
  }
});
