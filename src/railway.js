import { railwayMode } from './config/railway-mode.js';

try {
  const mode = railwayMode(process.env);
  if (mode === 'database-readonly') await import('./portal-database.js');
  else await import('./railway-staging.js');
} catch {
  console.error('[biometric-service] Railway runtime could not start; check mode and portal configuration');
  process.exitCode = 1;
}
