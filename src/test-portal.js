import { loadReadOnlyPortalConfig } from './config/read-only-portal.js';
import { startReadOnlyPortal } from './infrastructure/portal/read-only-runtime.js';

try {
  const runtime = await startReadOnlyPortal({ config: loadReadOnlyPortalConfig(process.env) });
  console.log('[biometric-service] read-only test portal listening');
  console.log('[biometric-service] database-readonly; device ingest and outbound delivery unavailable in this runtime');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().then(() => process.exit(0), () => process.exit(1));
  });
} catch (error) {
  const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '') ? error.code : 'READ_PORTAL_START_FAILED';
  console.error(`[biometric-service] read-only test portal failed (${code})`);
  process.exitCode = 1;
}
