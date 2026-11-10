import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { loadCloudIngestConfig } from '../src/config/cloud-ingest.js';

const sourceName = '.env.railway.ingest.complete.tidb';
const railwayName = '.env.railway.ingest.basic.complete.tidb';
const deviceName = '.env.device-basic.tidb';
const defaultDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// This local preparation never connects to a device, database or hosting API.
// Existing output pairs are validated and reused, never silently rotated.
export async function prepareNativeBasicDeployment({ directory = defaultDirectory } = {}) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'tolan-biometric-service') throw invalid();
  const source = parseEnv(await fs.readFile(path.join(root, sourceName), 'utf8'));
  if (source.BIOMETRIC_RAILWAY_MODE !== 'database-ingest' ||
      Object.keys(source).some(key => key.startsWith('TIDB_SOURCE_')) ||
      Object.hasOwn(source, 'BIOMETRIC_INGEST_BASIC_USERNAME') ||
      Object.hasOwn(source, 'BIOMETRIC_INGEST_BASIC_PASSWORD')) throw invalid();
  delete source.DATABASE_URL; // The obsolete root URL is not an ingest setting.
  const initial = loadCloudIngestConfig(source);
  const origin = new URL(initial.portal.origin);
  if (origin.protocol !== 'https:' || (origin.port && origin.port !== '443')) throw invalid();
  source.BIOMETRIC_PORTAL_ORIGIN = origin.origin;
  if (Object.hasOwn(source, 'BIOMETRIC_STAGING_PORTAL_ORIGIN')) source.BIOMETRIC_STAGING_PORTAL_ORIGIN = origin.origin;

  const outputPaths = [path.join(root, railwayName), path.join(root, deviceName)];
  const present = await Promise.all(outputPaths.map(exists));
  if (present[0] !== present[1]) throw invalid();
  let values;
  let device;
  if (present[0]) {
    values = parseEnv(await fs.readFile(outputPaths[0], 'utf8'));
    device = parseEnv(await fs.readFile(outputPaths[1], 'utf8'));
    if (Object.keys(values).length !== Object.keys(source).length + 2 ||
        Object.entries(source).some(([key, value]) => values[key] !== value)) throw invalid();
  } else {
    values = { ...source, BIOMETRIC_INGEST_BASIC_USERNAME: 'zk',
      BIOMETRIC_INGEST_BASIC_PASSWORD: randomBytes(16).toString('hex') };
    device = {};
  }
  const config = loadCloudIngestConfig(values);
  const credentials = config.basicCredentials;
  if (!credentials || config.autoFinalizeNewPunches !== false) throw invalid();
  const address = `https://${credentials.username}:${credentials.password}@${origin.hostname}:443`;
  const expectedDevice = { DEVICE_SERVER_ADDRESS: address,
    DEVICE_BASIC_USERNAME: credentials.username, DEVICE_BASIC_PASSWORD: credentials.password };
  if (present[0]) {
    if (Object.keys(device).length !== Object.keys(expectedDevice).length ||
        Object.entries(expectedDevice).some(([key, value]) => device[key] !== value)) throw invalid();
  } else {
    // A partial failure retains the first file for deliberate recovery. A rerun
    // refuses an incomplete pair rather than replacing a deployed machine key.
    await fs.writeFile(outputPaths[0], encode(values), { flag: 'wx', mode: 0o600 });
    await fs.writeFile(outputPaths[1], '# Private device credential: do not publish or send a photo of this URL.\n' + encode(expectedDevice),
      { flag: 'wx', mode: 0o600 });
  }
  return Object.freeze({ passed: true, reused: present[0], files: [railwayName, deviceName],
    variables: Object.keys(values).length, addedVariables: 2, existingSettingsPreserved: true,
    originsCanonicalized: true, rootDatabaseUrlOmitted: true, deviceUrlLength: address.length,
    passwordBytesOfEntropy: 16, secretsPrinted: false, networkConnections: false,
    sourceDatabaseConnected: false, deviceChanged: false });
}

function encode(values) {
  // Dotenv is not JSON: backslashes and quotes must survive Node's actual
  // parser unchanged. Refuse an unsupported value before writing either file.
  const result = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') throw invalid();
    for (const candidate of [`'${value}'`, `"${value}"`, value]) {
      try {
        const parsed = parseEnv(`${key}=${candidate}\n`);
        if (Object.keys(parsed).length === 1 && parsed[key] === value) return `${key}=${candidate}`;
      } catch {}
    }
    throw invalid();
  }).join('\n') + '\n';
  const parsed = parseEnv(result);
  if (Object.keys(parsed).length !== Object.keys(values).length ||
      Object.entries(values).some(([key, value]) => parsed[key] !== value)) throw invalid();
  return result;
}
async function exists(filename) {
  try { await fs.lstat(filename); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
function invalid() {
  return Object.assign(new Error('Native Basic deployment preparation is invalid; existing private files were preserved'),
    { code: 'NATIVE_BASIC_PREPARATION_INVALID' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw invalid();
    console.log(JSON.stringify(await prepareNativeBasicDeployment()));
  } catch {
    console.error('NATIVE_BASIC_PREPARATION_FAILED: check the private input and output pair; no credentials were printed.');
    process.exitCode = 1;
  }
}
