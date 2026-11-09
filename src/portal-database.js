import { loadStandalonePortalConfig } from './config/standalone-portal.js';
import { startReadOnlyPortal } from './infrastructure/portal/read-only-runtime.js';

try {
  const runtime = await startReadOnlyPortal({ config: loadStandalonePortalConfig(process.env) });
  console.log('[biometric-service] standalone portal listening; mode=database-readonly');
  console.log('[biometric-service] device ingest, processing and outbound delivery unavailable in this runtime');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().then(() => process.exit(0), () => process.exit(1));
  });
} catch (error) {
  const allowed = ['STANDALONE_PORTAL_CONFIG_INVALID', 'READ_PORTAL_START_FAILED'];
  const code = allowed.includes(error?.code) || /^READ_ONLY_DATABASE_[A-Z_]+$/.test(error?.code ?? '')
    ? error.code : 'STANDALONE_PORTAL_START_FAILED';
  console.error(`[biometric-service] standalone read-only portal failed (${code})`);
  process.exitCode = 1;
}
