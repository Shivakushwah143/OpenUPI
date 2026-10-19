import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenupiAdminServer } from './server.js';
import { DEFAULT_PORT, readOpenupiAdminConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single-host installs keep their settings in the project's env file. Container
// deployments receive them through env_file, so this is a no-op there.
if (!process.env.ADMIN_API_KEY && typeof process.loadEnvFile === 'function') {
  for (const candidate of [
    path.resolve(__dirname, '../../../.env'),
    path.resolve(__dirname, '../../../.env.staging')
  ]) {
    try {
      if (fs.existsSync(candidate)) {
        process.loadEnvFile(candidate);
        if (process.env.ADMIN_API_KEY) break;
      }
    } catch {
      // Ignore unreadable env files; the config check reports what is missing.
    }
  }
}

/**
 * Starts the OpenUPI admin (default http://127.0.0.1:6200).
 *
 * @param {number|null} [port]
 * @param {{ config?: ReturnType<typeof readOpenupiAdminConfig>, env?: Record<string,string|undefined> }} [options]
 * @returns {Promise<{ port: number, close: () => Promise<void>, server: OpenupiAdminServer }>}
 */
export function startOpenupiAdminServer(port = null, options = {}) {
  const config = options.config || readOpenupiAdminConfig(options.env || process.env);
  const finalPort = port || config.port || DEFAULT_PORT;
  const server = new OpenupiAdminServer({ ...options, config });
  const rawServer = server.createServer();

  return new Promise((resolve, reject) => {
    rawServer.once('error', reject);
    const instance = rawServer.listen(finalPort, () => {
      rawServer.off('error', reject);
      console.log(`[OpenUPI Admin] Listening on port ${finalPort}`);
      resolve({
        port: finalPort,
        server,
        close: () => new Promise(done => instance.close(() => done()))
      });
    });
  });
}

// Auto-run when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let running;
  try {
    running = await startOpenupiAdminServer();
  } catch (err) {
    console.error('[OpenUPI Admin] Startup refused:', err.message);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[OpenUPI Admin] ${signal} received; shutting down...`);
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    try {
      await running.close();
    } catch {
      // Ignore close errors during shutdown.
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
