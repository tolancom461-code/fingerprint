import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { railwayStagingEnvironment } from './config/railway-staging.js';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, railwayStagingEnvironment(process.env, serviceRoot));

console.log('[biometric-service] Railway staging: infrastructure-only; this is not a device-ingest deployment');
console.log('[biometric-service] Railway staging: all devices denied; database, administration, API and outbound bridge disabled');

// Dynamic import is deliberate: the existing runtime must read its configuration
// only after the isolated staging overrides above have been applied.
await import('./index.js');
