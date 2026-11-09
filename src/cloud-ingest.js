import { loadCloudIngestConfig } from './config/cloud-ingest.js';
import { startCloudIngest } from './infrastructure/ingest/cloud-runtime.js';

try {
  const runtime = await startCloudIngest({ config: loadCloudIngestConfig(process.env) });
  console.log('[biometric-service] authenticated ingest listening; mode=database-ingest; outbound delivery disabled');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().then(() => process.exit(0), () => process.exit(1));
  });
} catch (error) {
  const code = /^(?:CLOUD_INGEST_|INGEST_DATABASE_|AUTOMATIC_ELIGIBILITY_)[A-Z_]{1,64}$/.test(error?.code ?? '')
    ? error.code : 'CLOUD_INGEST_START_FAILED';
  console.error(`[biometric-service] cloud ingest failed (${code})`);
  process.exitCode = 1;
}
