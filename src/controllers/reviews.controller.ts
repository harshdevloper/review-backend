import type { Request, Response } from 'express';
import { z } from 'zod';
import { parsePlayStoreUrl } from '../utils/parsePlayStoreUrl.js';
import { fetchAppDetails, fetchReviews } from '../services/playScraper.service.js';
import { computeAnalytics } from '../services/analytics.service.js';
import { getCachedResult, setCachedResult } from '../services/cache.service.js';
import { SseChannel } from '../utils/sse.js';
import { AppError, toAppError } from '../utils/errors.js';
import { env } from '../config/env.js';
import type { ReviewFetchResult } from '../types/review.types.js';

export const reviewsBodySchema = z.object({
  url: z.string().min(1, 'A Play Store URL is required.'),
});

type StageName = 'connecting' | 'app-details' | 'downloading-reviews' | 'analytics' | 'preparing';

async function performFetch(
  rawUrl: string,
  onStage: (stage: StageName, message: string, progress: number, reviewCount?: number) => void,
): Promise<ReviewFetchResult> {
  const { packageName, lang, country } = parsePlayStoreUrl(rawUrl);

  onStage('connecting', 'Connecting to Google Play...', 8);

  onStage('app-details', 'Fetching application details...', 20);
  const app = await fetchAppDetails(packageName, lang, country);

  onStage('downloading-reviews', 'Downloading reviews...', 30, 0);
  const reviews = await fetchReviews(packageName, lang, country, (count) => {
    const progress = 30 + Math.min(count / env.maxReviews, 1) * 50;
    onStage('downloading-reviews', `Downloading reviews... (${count} fetched)`, progress, count);
  });

  onStage('analytics', 'Generating analytics...', 88);
  const analytics = computeAnalytics(reviews);

  onStage('preparing', 'Preparing dashboard...', 96);

  const result: ReviewFetchResult = {
    packageName,
    app,
    reviews,
    analytics,
    fetchedAt: new Date().toISOString(),
  };

  setCachedResult(packageName, result);
  return result;
}

export async function streamReviews(req: Request, res: Response): Promise<void> {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const channel = new SseChannel(res);

  try {
    const result = await performFetch(url, (stage, message, progress, reviewCount) => {
      channel.send('stage', { stage, message, progress: Math.round(progress), reviewCount });
    });
    channel.send('complete', { packageName: result.packageName, reviewCount: result.reviews.length, progress: 100 });
  } catch (error) {
    const appError = toAppError(error);
    // named "fetch-error" (not "error") so it doesn't collide with EventSource's
    // native connection-level "error" event on the client
    channel.send('fetch-error', {
      code: appError.code,
      message: appError.message,
      suggestion: appError.suggestion,
    });
  } finally {
    channel.close();
  }
}

export async function postReviews(req: Request, res: Response): Promise<void> {
  const { url } = req.body as { url: string };
  const result = await performFetch(url, () => {});
  res.status(200).json(result);
}

export async function getCachedReviews(req: Request, res: Response): Promise<void> {
  const packageName = req.params.packageName;
  if (typeof packageName !== 'string' || !packageName) {
    throw new AppError('VALIDATION_ERROR', 'packageName is required.');
  }
  const cached = getCachedResult(packageName);
  if (!cached) {
    throw new AppError('NOT_CACHED', `No cached data for ${packageName}.`, 404);
  }
  res.status(200).json(cached);
}
