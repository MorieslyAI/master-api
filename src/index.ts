import { env }         from './config/env.js';
import { initFirebase } from './lib/firebase.js';
import { buildApp }     from './app.js';

async function main(): Promise<void> {
  console.log('[boot] Menginisialisasi Firebase...');
  initFirebase();

  const app = await buildApp();

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Master API berjalan di http://${env.HOST}:${env.PORT}`);
  app.log.info(`Environment: ${env.NODE_ENV}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.warn(`[shutdown] Menerima ${signal}. Menutup server...`);
    await app.close();
    app.log.info('[shutdown] Server berhasil ditutup.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
