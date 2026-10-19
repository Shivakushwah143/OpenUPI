import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminServer } from './server.js';
import { getDatabase, runMigrations, ensureDatabaseInitialized } from '@youpi/db';

export function startAdminServer(port = null, options = {}) {
  const finalPort = port || Number(process.env.MERCHANT_ADMIN_PORT || 6001);
  const db = options.db || getDatabase();
  ensureDatabaseInitialized(db);
  runMigrations(db);

  const adminServer = new AdminServer({ db, ...options });
  const rawServer = adminServer.createServer();

  return new Promise(resolve => {
    const instance = rawServer.listen(finalPort, () => {
      console.log(`[Merchant Admin] Server listening on port ${finalPort}`);
      resolve({
        port: finalPort,
        close: () => new Promise(cb => instance.close(cb))
      });
    });
  });
}

// Auto-run if executed directly as main script
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startAdminServer();
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Merchant Admin] ${signal} received; shutting down gracefully...`);
    const forceExit = setTimeout(() => process.exit(1), 10000);
    forceExit.unref();
    try {
      await running.close();
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
