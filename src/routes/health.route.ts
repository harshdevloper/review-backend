import { Router } from 'express';
import { performance } from 'node:perf_hooks';
import { isStoreEnabled } from '../db/pool.js';
import { cacheStats } from '../services/cache.service.js';
import { jobStats } from '../services/job.service.js';

export const healthRouter = Router();

// Existing shape is unchanged so anything already polling /api/health keeps working.
healthRouter.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'playreview-ai-backend', time: new Date().toISOString() });
});

/**
 * Event-loop delay is the number that matters for this service: a single synchronous gzip or
 * JSON.parse of a large payload stalls every in-flight SSE stream, and that is invisible in
 * request timings alone.
 */
function measureLoopDelay(): Promise<number> {
  return new Promise((resolve) => {
    const started = performance.now();
    setImmediate(() => resolve(Number((performance.now() - started).toFixed(2))));
  });
}

healthRouter.get('/metrics', async (_req, res) => {
  const memory = process.memoryUsage();
  const toMb = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(1));

  res.status(200).json({
    uptimeSeconds: Math.round(process.uptime()),
    eventLoopDelayMs: await measureLoopDelay(),
    memoryMb: { rss: toMb(memory.rss), heapUsed: toMb(memory.heapUsed), external: toMb(memory.external) },
    cache: cacheStats(),
    jobs: jobStats(),
    persistence: isStoreEnabled() ? 'postgres' : 'disk-only',
  });
});
