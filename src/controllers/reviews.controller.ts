import type { Request, Response } from 'express';
import { z } from 'zod';
import { startJob, subscribe, runToCompletion } from '../services/job.service.js';
import { getCachedResult, getCachedBuffer } from '../services/cache.service.js';
import { SseChannel } from '../utils/sse.js';
import { AppError, toAppError } from '../utils/errors.js';

export const reviewsBodySchema = z.object({
  url: z.string().min(1, 'A Play Store URL is required.'),
});

// Reviews are streamed out in chunks rather than one event per page: a page is only ~150 rows and
// one SSE frame per page would be mostly framing overhead on a 18k-review fetch.
const STREAM_CHUNK = 500;

export function streamReviews(req: Request, res: Response): void {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const channel = new SseChannel(res);

  let job;
  try {
    job = startJob(url);
  } catch (error) {
    const appError = toAppError(error);
    channel.send('fetch-error', {
      code: appError.code,
      message: appError.message,
      suggestion: appError.suggestion,
    });
    channel.close();
    return;
  }

  let pending: unknown[] = [];
  const flush = () => {
    // Replaying a stored app hands over everything at once — tens of thousands of rows. Slicing it
    // keeps each frame parseable on arrival so the browser renders progressively instead of
    // blocking on one huge JSON blob.
    while (pending.length > 0) {
      channel.send('reviews', pending.splice(0, STREAM_CHUNK));
    }
  };

  const unsubscribe = subscribe(job, {
    onStage: (stage, message, progress, reviewCount) => {
      channel.send('stage', { stage, message, progress: Math.round(progress), reviewCount });
    },
    onApp: (app) => channel.send('app', app),
    onReviews: (batch) => {
      pending.push(...batch);
      if (pending.length >= STREAM_CHUNK) flush();
    },
    onAnalytics: (analytics) => {
      // reviews must land before the analytics computed from them, or the client renders charts
      // that disagree with the list underneath
      flush();
      channel.send('analytics', analytics);
    },
    onComplete: (packageName, reviewCount) => {
      flush();
      channel.send('complete', { packageName, reviewCount, progress: 100 });
      cleanup();
    },
    // named "fetch-error" (not "error") so it doesn't collide with EventSource's
    // native connection-level "error" event on the client
    onError: (error) => {
      flush();
      channel.send('fetch-error', error);
      cleanup();
    },
  });

  function cleanup() {
    unsubscribe();
    channel.close();
  }

  // the client going away must not kill the job — another tab may be watching, and the result
  // still lands in the cache for a later deep link
  res.on('close', unsubscribe);
}

export async function postReviews(req: Request, res: Response): Promise<void> {
  const { url } = req.body as { url: string };
  const result = await runToCompletion(url);
  res.status(200).json(result);
}

export async function getCachedReviews(req: Request, res: Response): Promise<void> {
  const packageName = req.params.packageName;
  if (typeof packageName !== 'string' || !packageName) {
    throw new AppError('VALIDATION_ERROR', 'packageName is required.');
  }

  const buffer = getCachedBuffer(packageName);
  if (!buffer) {
    throw new AppError('NOT_CACHED', `No cached data for ${packageName}.`, 404);
  }

  // The cache already holds gzipped JSON, which is exactly what the wire wants. Sending it
  // verbatim skips gunzip + parse + stringify + re-gzip — ~480ms of blocking CPU per request on a
  // 16k-review app. `no-transform` keeps the compression middleware from touching it again.
  if (req.acceptsEncodings('gzip')) {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', buffer.byteLength);
    res.setHeader('Cache-Control', 'no-transform');
    res.end(buffer);
    return;
  }

  // rare (curl without --compressed, ancient clients): fall back to plain JSON
  const cached = getCachedResult(packageName);
  if (!cached) throw new AppError('NOT_CACHED', `No cached data for ${packageName}.`, 404);
  res.status(200).json(cached);
}
