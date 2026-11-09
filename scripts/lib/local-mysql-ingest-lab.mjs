import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const osKeys = ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC', 'SystemDrive', 'PATHEXT'];

// No existing data directory, database server, account or network host is accepted.
export async function createLocalIngestMysqlLab() {
  const binary = 'C:/Program Files/MySQL/MySQL Server 8.4/bin/mysqld.exe';
  await fs.access(binary);
  const directory = await fs.mkdtemp(path.join(root, 'verification', 'cloud-ingest-mysql-'));
  const data = path.join(directory, 'data');
  const bootstrap = path.join(directory, 'private-bootstrap.sql');
  const port = await freeLocalPort();
  const password = randomBytes(32).toString('hex');
  const environment = Object.fromEntries(osKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const args = ['--no-defaults', `--basedir=${path.dirname(path.dirname(binary))}`, `--datadir=${data}`,
    '--bind-address=127.0.0.1', `--port=${port}`, '--mysqlx=OFF', '--skip-name-resolve',
    '--default-time-zone=+00:00', '--max-connections=30', '--innodb-buffer-pool-size=67108864',
    `--log-error=${path.join(directory, 'private-mysql.log')}`, `--pid-file=${path.join(directory, 'mysql.pid')}`];
  let child;
  let initializer;
  const connect = database => mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password,
    ...(database ? { database } : {}), connectTimeout: 2000, dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, multipleStatements: false });
  const sql = async (statement, params = [], database = 'fingerprint') => {
    if (!['fingerprint', null].includes(database)) throw new Error('LOCAL_LAB_DATABASE_REJECTED');
    const connection = await connect(database);
    try { return await connection.execute(statement, params); } finally { await connection.end(); }
  };
  const start = async first => {
    child = startChild(binary, [...args, ...(first ? [`--init-file=${bootstrap}`] : [])], environment);
    await until(async () => {
      if (!running(child)) throw new Error('LOCAL_LAB_PROCESS_EXITED');
      try { const connection = await connect(); await connection.end(); return true; } catch { return false; }
    }, 30000);
  };
  const stop = async () => {
    if (!running(child)) return;
    let connection;
    try {
      connection = await connect(); connection.on('error', () => {});
      await connection.query('SHUTDOWN');
      await until(() => !running(child), 15000);
    } finally { connection?.destroy(); }
  };
  const close = async () => {
    let graceful = true;
    try { await stop(); } catch { graceful = false; if (running(child)) child.kill(); }
    if (running(initializer)) initializer.kill();
    await until(() => !running(child) && !running(initializer), 10000).catch(() => {});
    await fs.unlink(bootstrap).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { mysqlStopped: !running(child), initializerStopped: !running(initializer), graceful,
      bootstrapRemoved: !await exists(bootstrap), syntheticDataRetained: true };
  };
  try {
    await fs.mkdir(data);
    initializer = startChild(binary, ['--no-defaults', '--initialize-insecure',
      `--basedir=${path.dirname(path.dirname(binary))}`, `--datadir=${data}`, '--mysqlx=OFF',
      `--log-error=${path.join(directory, 'private-initialize.log')}`], environment);
    await until(() => !running(initializer), 60000);
    if (initializer.exitCode !== 0) throw new Error('LOCAL_LAB_INITIALIZATION_FAILED');
    await fs.writeFile(bootstrap, `ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}';\nCREATE USER 'root'@'127.0.0.1' IDENTIFIED BY '${password}';\nGRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;\n`, { flag: 'wx', mode: 0o600 });
    await start(true);
    await fs.unlink(bootstrap);
    return Object.freeze({ directory, port, sql, stop, start: () => start(false), close });
  } catch (error) { await close(); throw error; }
}
export async function freeLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  if ([9095, 9096, 9097, 4000].includes(port)) return freeLocalPort();
  return port;
}
function startChild(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.spawnFailed = false;
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  child.on('error', () => { child.spawnFailed = true; });
  return child;
}
function running(child) { return Boolean(child && child.exitCode === null && child.signalCode === null && !child.spawnFailed); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
export async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(100); }
  throw Object.assign(new Error('Local verification wait timed out'), { code: 'LOCAL_VERIFICATION_TIMEOUT' });
}
