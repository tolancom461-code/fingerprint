import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secrets = ['SYNTHETIC_LEGACY_DATABASE_SECRET', 'SYNTHETIC_TEST_DATABASE_SECRET', 'SYNTHETIC_PORTAL_DATABASE_SECRET', 'SYNTHETIC_BRIDGE_SECRET'];

function isolatedEnvironment() {
  const allowed = ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'SystemDrive', 'PATHEXT'];
  return { ...Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), NODE_OPTIONS: '' };
}

async function laboratory(t, mode) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'biometric-dispatcher-test-'));
  const sentinel = path.join(temporary, 'original-cursor.json');
  await fs.writeFile(sentinel, '{"cursor":"987654321"}\n');
  const sentinelBefore = await fs.readFile(sentinel, 'utf8');
  let connections = 0;
  const trap = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => { trap.once('error', reject); trap.listen(0, '127.0.0.1', resolve); });
  const trapPort = String(trap.address().port);
  const port = await freePort();
  const environment = {
    ...isolatedEnvironment(), NODE_ENV: 'production', PORT: String(port),
    BIOMETRIC_STAGING_DATA_DIR: temporary, BIOMETRIC_STAGING_PORTAL_ENABLED: 'false',
    BIOMETRIC_STORAGE_MODE: 'database', BIOMETRIC_ALLOWED_DEVICES: 'zkteco:SYNTHETIC-DEVICE',
    BIOMETRIC_ALLOWED_SERIALS: 'SYNTHETIC-DEVICE', BIOMETRIC_ATTLOG_ACK_MODE: 'ack', BIOMETRIC_ACK_MODE: 'ack',
    BIOMETRIC_DB_HOST: '127.0.0.1', BIOMETRIC_DB_PORT: trapPort,
    BIOMETRIC_DB_USER: 'forbidden-legacy-reader', BIOMETRIC_DB_PASSWORD: secrets[0], BIOMETRIC_DB_NAME: 'test',
    BIOMETRIC_TEST_DB_HOST: '127.0.0.1', BIOMETRIC_TEST_DB_PORT: trapPort,
    BIOMETRIC_TEST_DB_USER: 'forbidden-fixture-reader', BIOMETRIC_TEST_DB_PASSWORD: secrets[1],
    BIOMETRIC_TEST_DB_NAME: 'biometric_portal_test_dispatcher',
    BIOMETRIC_ADMIN_ENABLED: 'true', BIOMETRIC_ADMIN_HOST: '0.0.0.0', BIOMETRIC_ADMIN_PORT: 'invalid',
    BIOMETRIC_FINAL_EVENTS_API_ENABLED: 'true', BIOMETRIC_FINAL_EVENTS_API_HOST: '0.0.0.0', BIOMETRIC_FINAL_EVENTS_API_PORT: 'invalid',
    BIOMETRIC_WEB_BRIDGE_ENABLED: 'true', BIOMETRIC_WEB_BRIDGE_TARGET_URL: `http://127.0.0.1:${trapPort}`,
    BIOMETRIC_WEB_BRIDGE_TOKEN: secrets[3], BIOMETRIC_WEB_BRIDGE_STATE_FILE: sentinel,
    BIOMETRIC_AUTO_FINALIZE_NEW_PUNCHES: 'true'
  };
  // Poison even the new namespace in the default branch. It must not activate a
  // database profile or consume its deliberately incomplete configuration.
  if (mode === undefined) Object.assign(environment, {
    BIOMETRIC_PORTAL_DB_HOST: '127.0.0.1', BIOMETRIC_PORTAL_DB_PORT: trapPort,
    BIOMETRIC_PORTAL_DB_USER: 'forbidden-standalone-reader', BIOMETRIC_PORTAL_DB_PASSWORD: secrets[2],
    BIOMETRIC_PORTAL_DB_NAME: 'fingerprint', BIOMETRIC_PORTAL_DB_CONFIRMED_NAME: 'fingerprint'
  });
  else environment.BIOMETRIC_RAILWAY_MODE = mode;
  const child = spawn(process.execPath, ['src/railway.js'], {
    cwd: serviceRoot, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-65536); });
  child.stderr.on('data', bytes => { output = (output + bytes.toString()).slice(-65536); });
  const exited = once(child, 'close');
  let closed = false;
  exited.then(() => { closed = true; }, () => { closed = true; });
  t.after(async () => {
    if (!closed) child.kill('SIGTERM');
    await until(() => closed, { timeout: 3000 }).catch(() => {});
    if (!closed) child.kill('SIGKILL');
    await exited;
    await new Promise(resolve => trap.close(resolve));
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('biometric-dispatcher-test-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { child, exited, port, get output() { return output; }, get connections() { return connections; },
    async waitForStart() {
      await until(() => output.includes(`listening on http://0.0.0.0:${port}`), {
        fail: () => closed, timeout: 8000
      });
    },
    async assertNoSideEffects() {
      assert.equal(connections, 0);
      assert.equal(await fs.readFile(sentinel, 'utf8'), sentinelBefore);
      for (const secret of secrets) assert.equal(output.includes(secret), false);
    }
  };
}

test('real Railway dispatcher defaults to the existing isolated demo and never connects using inherited database or bridge settings', { timeout: 20000 }, async t => {
  const lab = await laboratory(t);
  await lab.waitForStart();
  const base = `http://127.0.0.1:${lab.port}`;
  const health = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) });
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'OK');
  for (const method of ['GET', 'POST']) {
    const response = await fetch(base + '/iclock/cdata?SN=SYNTHETIC-DEVICE&table=ATTLOG', {
      method, ...(method === 'POST' ? { body: 'SYNTHETIC-NOT-TO-CAPTURE' } : {}), signal: AbortSignal.timeout(2000)
    });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'DENIED');
  }
  for (const route of ['/api/overview', '/api/v1/final-events']) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 404);
    await response.text();
  }
  assert.match(lab.output, /Railway staging: infrastructure-only/);
  assert.match(lab.output, /storage mode: file/);
  assert.doesNotMatch(lab.output, /standalone portal listening/);
  await lab.assertNoSideEffects();
  lab.child.kill('SIGTERM');
  const [code, signal] = await lab.exited;
  if (process.platform === 'win32') assert.ok(code === 0 || signal === 'SIGTERM');
  else assert.equal(code, 0);
});

test('explicit database-readonly with missing new configuration exits without falling back to demo or legacy credentials', { timeout: 10000 }, async t => {
  const lab = await laboratory(t, 'database-readonly');
  await until(() => lab.child.exitCode !== null || lab.child.signalCode !== null, { timeout: 5000 });
  const [code] = await lab.exited;
  assert.equal(code, 1);
  assert.match(lab.output, /standalone read-only portal failed \(STANDALONE_PORTAL_CONFIG_INVALID\)/);
  assert.doesNotMatch(lab.output, /Railway staging|listening on|standalone portal listening|\bat .*\.js:/);
  await lab.assertNoSideEffects();
});

test('unknown Railway mode fails before either runtime starts and cannot connect to an inherited database', { timeout: 10000 }, async t => {
  const lab = await laboratory(t, 'production');
  await until(() => lab.child.exitCode !== null || lab.child.signalCode !== null, { timeout: 5000 });
  const [code] = await lab.exited;
  assert.equal(code, 1);
  assert.match(lab.output, /Railway runtime could not start/);
  assert.doesNotMatch(lab.output, /Railway staging|standalone read-only portal failed|listening on|\bat .*\.js:/);
  await lab.assertNoSideEffects();
});

test('container and npm commands select the dispatcher while the real portal CLI imports only its explicit config and read-only runtime', async () => {
  const [dockerfile, packageText, dispatcher, portalCli, readRuntime] = await Promise.all([
    fs.readFile(path.join(serviceRoot, 'Dockerfile'), 'utf8'),
    fs.readFile(path.join(serviceRoot, 'package.json'), 'utf8'),
    fs.readFile(path.join(serviceRoot, 'src/railway.js'), 'utf8'),
    fs.readFile(path.join(serviceRoot, 'src/portal-database.js'), 'utf8'),
    fs.readFile(path.join(serviceRoot, 'src/infrastructure/portal/read-only-runtime.js'), 'utf8')
  ]);
  const command = /^CMD\s+(\[.*\])\s*$/m.exec(dockerfile);
  assert.ok(command);
  assert.deepEqual(JSON.parse(command[1]), ['node', 'src/railway.js']);
  const scripts = JSON.parse(packageText).scripts;
  assert.equal(scripts['start:railway'], 'node src/railway.js');
  assert.equal(scripts['start:portal-database'], 'node src/portal-database.js');
  assert.equal(scripts['start:railway-staging'], 'node src/railway-staging.js');
  assert.equal(scripts.start, 'node src/index.js');
  const dispatcherImports = importsOf(dispatcher);
  assert.deepEqual(dispatcherImports.sort(), ['./config/railway-mode.js', './cloud-ingest.js', './portal-database.js', './railway-staging.js'].sort());
  assert.match(dispatcher, /if\s*\(mode === 'database-ingest'\)\s*await import\('\.\/cloud-ingest\.js'\)/);
  assert.match(dispatcher, /if\s*\(mode === 'database-readonly'\)\s*await import\('\.\/portal-database\.js'\)/);
  assert.deepEqual(importsOf(portalCli).sort(), ['./config/standalone-portal.js', './infrastructure/portal/read-only-runtime.js'].sort());
  for (const imported of [...dispatcherImports, ...importsOf(portalCli), ...importsOf(readRuntime)]) {
    assert.doesNotMatch(imported, /(?:^|\/)index\.js$|config\/env\.js$|adapter|web-bridge|canonical|worker|dotenv/);
  }
  assert.doesNotMatch(portalCli, /process\.env\.(?:BIOMETRIC_DB_|BIOMETRIC_TEST_DB_|TIDB_SETUP_)/);
});

function importsOf(source) {
  return [...source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function until(predicate, { timeout = 5000, fail = () => false } = {}) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (fail() || Date.now() >= deadline) throw new Error('Synthetic Railway dispatcher did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
