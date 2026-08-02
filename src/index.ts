import { createApp } from './app.js';
import { env } from './config/env.js';
import { ensureSchema } from './db/schema.js';
import { closePool } from './db/pool.js';

const app = createApp();

// A database that is unreachable shouldn't stop the server booting — it degrades to re-scraping,
// which is exactly how it behaved before persistence existed.
ensureSchema().catch((error: Error) => {
  console.error('[db] schema setup failed, continuing without persistence:', error.message);
});

const server = app.listen(env.port, () => {
  console.log(`PlayReview AI backend listening on http://localhost:${env.port}`);
});

// SSE connections are long-lived by design, so the default "wait for every socket" shutdown would
// hang until each stream ended. Stop accepting new work, give in-flight requests a brief window,
// then exit regardless. Killing the process outright (as a force-kill does) can leave a half-written
// cache file and a Postgres session idle-in-transaction until its TCP keepalive expires.
const SHUTDOWN_GRACE_MS = 5000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, closing`);

  const forced = setTimeout(() => {
    console.warn('[shutdown] grace period elapsed, exiting anyway');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  forced.unref();

  server.close(() => console.log('[shutdown] http server closed'));
  server.closeIdleConnections?.();

  try {
    await closePool();
  } catch (error) {
    console.warn('[shutdown] pool close failed:', (error as Error).message);
  }

  clearTimeout(forced);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// A rejection that reaches here would otherwise take the process down silently mid-scrape.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason instanceof Error ? reason.message : reason);
});
