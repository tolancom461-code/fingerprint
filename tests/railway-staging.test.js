import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { railwayStagingEnvironment } from '../src/config/railway-staging.js';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('staging uses its default port and dedicated data paths', () => {
  const settings = railwayStagingEnvironment({}, serviceRoot);
  const data = path.join(serviceRoot, 'var', 'railway-staging');
  assert.equal(settings.PORT, '8080');
  assert.equal(settings.BIOMETRIC_PORT, '8080');
  assert.equal(settings.BIOMETRIC_CAPTURE_DIR, path.join(data, 'captures'));
  assert.equal(settings.BIOMETRIC_LOG_DIR, path.join(data, 'logs'));
  assert.equal(settings.BIOMETRIC_WEB_BRIDGE_STATE_FILE, path.join(data, 'web-bridge-state.json'));
});

test('staging accepts only complete decimal ports within the valid range', () => {
  for (const port of ['1', '443', '65535']) {
    assert.equal(railwayStagingEnvironment({ PORT: port }, serviceRoot).BIOMETRIC_PORT, port);
  }
  for (const port of ['0', '65536', '-1', '+80', '80suffix', '1.5', '1e3', '0x50', ' 80', '80 ', 'NaN', '999999999999999999999']) {
    assert.throws(() => railwayStagingEnvironment({ PORT: port }, serviceRoot), /PORT must/);
  }
});

test('staging overrides inherited production modes, allowlists and writable paths', () => {
  const settings = railwayStagingEnvironment({
    BIOMETRIC_HOST: '127.0.0.1', BIOMETRIC_PORT: '9095',
    BIOMETRIC_STORAGE_MODE: 'database', BIOMETRIC_ALLOWED_DEVICES: 'zkteco:PRODUCTION',
    BIOMETRIC_ALLOWED_SERIALS: 'PRODUCTION', BIOMETRIC_ACK_MODE: 'ack', BIOMETRIC_ATTLOG_ACK_MODE: 'ack',
    BIOMETRIC_ADMIN_ENABLED: 'true', BIOMETRIC_FINAL_EVENTS_API_ENABLED: 'true',
    BIOMETRIC_WEB_BRIDGE_ENABLED: 'true', BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'true',
    BIOMETRIC_CAPTURE_DIR: path.join(serviceRoot, 'var', 'captures'),
    BIOMETRIC_LOG_DIR: path.join(serviceRoot, 'var', 'logs'),
    BIOMETRIC_WEB_BRIDGE_STATE_FILE: path.join(serviceRoot, 'var', 'web-bridge-state.json')
  }, serviceRoot);
  assert.equal(settings.BIOMETRIC_HOST, '0.0.0.0');
  assert.equal(settings.BIOMETRIC_STORAGE_MODE, 'file');
  assert.equal(settings.BIOMETRIC_ALLOWED_DEVICES, '');
  assert.equal(settings.BIOMETRIC_ALLOWED_SERIALS, '');
  assert.equal(settings.BIOMETRIC_ACK_MODE, 'observe');
  assert.equal(settings.BIOMETRIC_ATTLOG_ACK_MODE, 'observe');
  for (const key of ['BIOMETRIC_ADMIN_ENABLED', 'BIOMETRIC_FINAL_EVENTS_API_ENABLED', 'BIOMETRIC_WEB_BRIDGE_ENABLED', 'BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES']) {
    assert.equal(settings[key], 'false');
  }
  for (const key of ['BIOMETRIC_CAPTURE_DIR', 'BIOMETRIC_LOG_DIR', 'BIOMETRIC_WEB_BRIDGE_STATE_FILE']) {
    assert.ok(settings[key].startsWith(path.join(serviceRoot, 'var', 'railway-staging') + path.sep));
  }
});

test('staging configuration never reads database credentials or unrelated production values', () => {
  const permitted = new Set(['PORT', 'BIOMETRIC_STAGING_DATA_DIR', 'RAILWAY_VOLUME_MOUNT_PATH']);
  const env = new Proxy({}, {
    get(_target, key) {
      assert.ok(permitted.has(key), `Unexpected environment read: ${String(key)}`);
      return undefined;
    }
  });
  assert.equal(railwayStagingEnvironment(env, serviceRoot).BIOMETRIC_STORAGE_MODE, 'file');
});

test('staging adds a dedicated subdirectory to an absolute Railway volume', () => {
  const volume = path.join(os.tmpdir(), 'staging-volume');
  const settings = railwayStagingEnvironment({ RAILWAY_VOLUME_MOUNT_PATH: volume }, serviceRoot);
  assert.equal(settings.BIOMETRIC_CAPTURE_DIR, path.join(volume, 'railway-staging', 'captures'));
  assert.throws(() => railwayStagingEnvironment({ RAILWAY_VOLUME_MOUNT_PATH: '../volume' }, serviceRoot), /must be absolute/);
});

test('custom staging parent takes precedence and relative paths cannot escape the service', () => {
  const custom = path.join(os.tmpdir(), 'custom-staging-parent');
  const settings = railwayStagingEnvironment({ BIOMETRIC_STAGING_DATA_DIR: custom, RAILWAY_VOLUME_MOUNT_PATH: '../ignored' }, serviceRoot);
  assert.equal(settings.BIOMETRIC_LOG_DIR, path.join(custom, 'railway-staging', 'logs'));
  const relative = railwayStagingEnvironment({ BIOMETRIC_STAGING_DATA_DIR: 'verification/data' }, serviceRoot);
  assert.equal(relative.BIOMETRIC_LOG_DIR, path.join(serviceRoot, 'verification', 'data', 'railway-staging', 'logs'));
  assert.throws(() => railwayStagingEnvironment({ BIOMETRIC_STAGING_DATA_DIR: '../escape' }, serviceRoot), /must stay inside/);
  assert.throws(() => railwayStagingEnvironment({ BIOMETRIC_STAGING_DATA_DIR: 'bad\0path' }, serviceRoot), /nonempty path/);
});

test('real staging runtime serves health, denies devices and terminates with SIGTERM without production side effects', { timeout: 20000 }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'biometric-railway-staging-test-'));
  const production = path.join(temporary, 'production');
  await fs.mkdir(production);
  const sentinel = path.join(production, 'web-bridge-state.json');
  await fs.writeFile(sentinel, '{"cursor":"987654"}\n');
  const originalSentinel = await fs.readFile(sentinel, 'utf8');
  let outgoingConnections = 0;
  const trap = net.createServer(socket => { outgoingConnections++; socket.destroy(); });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  const trapPort = trap.address().port;
  const port = await freePort();
  const child = spawn(process.execPath, ['src/railway-staging.js'], {
    cwd: serviceRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_OPTIONS: '', PORT: String(port),
      BIOMETRIC_STAGING_DATA_DIR: temporary,
      BIOMETRIC_STORAGE_MODE: 'database',
      BIOMETRIC_ALLOWED_DEVICES: 'zkteco:PRODUCTION', BIOMETRIC_ALLOWED_SERIALS: 'PRODUCTION',
      BIOMETRIC_ATTLOG_ACK_MODE: 'ack', BIOMETRIC_ACK_MODE: 'ack',
      BIOMETRIC_DB_HOST: '127.0.0.1', BIOMETRIC_DB_PORT: String(trapPort),
      BIOMETRIC_DB_USER: 'MUST_NOT_CONNECT', BIOMETRIC_DB_PASSWORD: 'DO_NOT_PRINT_DB_SECRET',
      BIOMETRIC_ADMIN_ENABLED: 'true', BIOMETRIC_ADMIN_HOST: '0.0.0.0', BIOMETRIC_ADMIN_PORT: 'invalid',
      BIOMETRIC_FINAL_EVENTS_API_ENABLED: 'true', BIOMETRIC_FINAL_EVENTS_API_HOST: '0.0.0.0', BIOMETRIC_FINAL_EVENTS_API_PORT: 'invalid',
      BIOMETRIC_WEB_BRIDGE_ENABLED: 'true', BIOMETRIC_WEB_BRIDGE_TARGET_URL: `http://127.0.0.1:${trapPort}`,
      BIOMETRIC_WEB_BRIDGE_TOKEN: 'DO_NOT_PRINT_BRIDGE_SECRET', BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'true',
      BIOMETRIC_CAPTURE_DIR: production, BIOMETRIC_LOG_DIR: production,
      BIOMETRIC_WEB_BRIDGE_STATE_FILE: sentinel,
      BIOMETRIC_LOG_TIMEZONE: 'invalid/timezone', BIOMETRIC_LOG_MAX_BYTES: 'invalid'
    }
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await new Promise(resolve => trap.close(resolve));
    // Cleanup is constrained to the temporary directory this test created.
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('biometric-railway-staging-test-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });

  await until(() => output.includes(`listening on http://0.0.0.0:${port}`), () => output, child);
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'OK');
  const handshake = await fetch(`${base}/iclock/cdata?SN=PRODUCTION&options=all`, { signal: AbortSignal.timeout(2000) });
  assert.equal(handshake.status, 403);
  assert.equal(await handshake.text(), 'DENIED');
  const payload = 'DO_NOT_CAPTURE_RAW_PAYLOAD_2026';
  const post = await fetch(`${base}/iclock/cdata?SN=PRODUCTION&table=ATTLOG`, {
    method: 'POST', body: payload, signal: AbortSignal.timeout(2000)
  });
  assert.equal(post.status, 403);
  assert.equal(await post.text(), 'DENIED');
  for (const endpoint of ['/api/overview', '/api/devices', '/api/v1/health', '/api/v1/final-events']) {
    const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 404, endpoint);
    await response.text();
  }
  assert.equal(outgoingConnections, 0);
  assert.equal(await fs.readFile(sentinel, 'utf8'), originalSentinel);
  assert.deepEqual(await fs.readdir(production), ['web-bridge-state.json']);
  const dataRoot = path.join(temporary, 'railway-staging');
  assert.deepEqual(await fs.readdir(path.join(dataRoot, 'captures')), []);
  const diagnostics = await fs.readFile(path.join(dataRoot, 'logs', 'service.ndjson'), 'utf8');
  assert.ok(!diagnostics.includes(payload));
  assert.ok(!output.includes('DO_NOT_PRINT_DB_SECRET'));
  assert.ok(!output.includes('DO_NOT_PRINT_BRIDGE_SECRET'));
  assert.match(output, /infrastructure-only/);
  assert.match(output, /allowed devices: 0/);
  assert.match(output, /storage mode: file/);
  assert.doesNotMatch(output, /database schema:/);

  child.kill('SIGTERM');
  const [code, signal] = await exited;
  if (process.platform === 'win32') {
    // Windows terminates child processes for SIGTERM rather than delivering a
    // POSIX signal callback. Linux/Railway must run the runtime's graceful path.
    assert.ok(code === 0 || signal === 'SIGTERM');
  } else {
    assert.equal(code, 0);
    assert.match(output, /SIGTERM received, shutting down/);
  }
});

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function until(predicate, readOutput, child) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`Staging runtime did not start: ${readOutput()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
