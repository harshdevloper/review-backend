import { EventEmitter } from 'node:events';
import { parsePlayStoreUrl } from '../utils/parsePlayStoreUrl.js';
import { fetchAppDetails, fetchReviews, syncNewReviews } from './playScraper.service.js';
import { computeAnalytics } from './analytics.service.js';
import { setCachedResult, getCachedResult } from './cache.service.js';
import { isStoreEnabled } from '../db/pool.js';
import { loadApp, loadReviews, saveApp, saveReviews } from './store.service.js';
import { AppError, toAppError } from '../utils/errors.js';
import type { AppDetails } from '../types/app.types.js';
import type { Analytics, Review, ReviewFetchResult } from '../types/review.types.js';
import type { ReviewFetchStopReason } from './playScraper.service.js';

export type JobStatus = 'running' | 'complete' | 'error';
export type StageName = 'connecting' | 'app-details' | 'downloading-reviews' | 'analytics' | 'preparing';

export interface JobError {
  code: string;
  message: string;
  suggestion?: string;
}

interface Job {
  packageName: string;
  status: JobStatus;
  app: AppDetails | null;
  reviews: Review[];
  analytics: Analytics | null;
  stage: StageName;
  message: string;
  progress: number;
  error: JobError | null;
  reviewCountry: string;
  reviewsComplete: boolean;
  reviewStopReason: ReviewFetchStopReason;
  startedAt: number;
  events: EventEmitter;
}

export interface JobHandlers {
  onStage: (stage: StageName, message: string, progress: number, reviewCount: number) => void;
  onApp: (app: AppDetails) => void;
  onReviews: (batch: Review[]) => void;
  onAnalytics: (analytics: Analytics) => void;
  onComplete: (packageName: string, reviewCount: number) => void;
  onError: (error: JobError) => void;
}

// Analytics over 18k reviews costs ~220ms, so it is recomputed on a timer rather than per page.
const ANALYTICS_INTERVAL_MS = 4000;

// Reading the store has to beat simply scraping again, or it is not worth having. A remote
// database on a slow link can be far slower than Google (measured: 163s to read back 15k stored
// reviews versus 62s to re-scrape them), which would leave the dashboard hanging on
// "Loading stored reviews...". If a read blows this budget the store is abandoned for that
// request and skipped entirely for a cooldown, so one slow database degrades to the old
// behaviour instead of breaking the app.
const STORE_READ_BUDGET_MS = 8000;
const STORE_COOLDOWN_MS = 5 * 60_000;
let storeDegradedUntil = 0;

function storeUsable(): boolean {
  return isStoreEnabled() && Date.now() >= storeDegradedUntil;
}

async function withReadBudget<T>(work: Promise<T>, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol('expired');
  const guard = new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => resolve(expired), STORE_READ_BUDGET_MS);
  });

  try {
    const result = await Promise.race([work, guard]);
    if (result === expired) {
      storeDegradedUntil = Date.now() + STORE_COOLDOWN_MS;
      console.warn(`[db] ${label} exceeded ${STORE_READ_BUDGET_MS}ms — falling back to scraping, store paused 5min`);
      return null;
    }
    return result as T;
  } catch (error) {
    storeDegradedUntil = Date.now() + STORE_COOLDOWN_MS;
    console.warn(`[db] ${label} failed (${(error as Error).message}) — falling back to scraping`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const jobs = new Map<string, Job>();

function toJobError(error: unknown): JobError {
  const appError = toAppError(error);
  return { code: appError.code, message: appError.message, suggestion: appError.suggestion };
}

function reviewTime(review: Review): number {
  const time = new Date(review.date).getTime();
  return Number.isNaN(time) ? -Infinity : time;
}

function sortNewestFirst(reviews: Review[]): Review[] {
  return reviews.sort((a, b) => reviewTime(b) - reviewTime(a) || a.id.localeCompare(b.id));
}

function emitStage(job: Job, stage: StageName, message: string, progress: number): void {
  job.stage = stage;
  job.message = message;
  job.progress = progress;
  job.events.emit('stage', stage, message, progress, job.reviews.length);
}

// The cache write is awaited before `complete` goes out: that event is the client's cue to GET the
// result, and racing it against an unfinished write would answer NOT_CACHED.
async function finish(job: Job, packageName: string): Promise<void> {
  sortNewestFirst(job.reviews);
  await saveApp(packageName, job.app!, {
    country: job.reviewCountry,
    complete: job.reviewsComplete,
    stopReason: job.reviewStopReason,
  }).catch((e: Error) => console.error('[db] saveApp:', e.message));

  const result: ReviewFetchResult = {
    packageName,
    app: job.app!,
    reviews: job.reviews,
    analytics: job.analytics!,
    fetchedAt: new Date().toISOString(),
    reviewCollection: {
      country: job.reviewCountry,
      complete: job.reviewsComplete,
      stopReason: job.reviewStopReason,
    },
  };
  await setCachedResult(packageName, result);
  job.status = 'complete';
  job.progress = 100;
  job.events.emit('complete', packageName, job.reviews.length);
}

/**
 * Pulls only what the job doesn't already hold. Known ids come from the reviews already in memory,
 * so this works the same whether they came from disk or from the database, and it never has to ask
 * a remote store what it has.
 */
async function catchUp(job: Job, packageName: string, lang: string, country: string): Promise<number> {
  const known = new Set(job.reviews.map((review) => review.id));

  const { app, country: resolvedCountry } = await fetchAppDetails(packageName, lang, country);
  job.app = app;
  job.reviewCountry = resolvedCountry;
  job.events.emit('app', app);

  const fresh = await syncNewReviews(
    packageName,
    lang,
    resolvedCountry,
    async (ids) => new Set(ids.filter((id) => !known.has(id))),
    (batch) => {
      for (const review of batch) known.add(review.id);
      job.reviews = batch.concat(job.reviews);
      job.events.emit('reviews', batch);
    },
  );

  if (fresh.length > 0) {
    job.analytics = computeAnalytics(job.reviews);
    job.events.emit('analytics', job.analytics);
    if (isStoreEnabled()) {
      await saveReviews(packageName, fresh).catch((e: Error) => console.error('[db] save:', e.message));
    }
  }
  return fresh.length;
}

/**
 * Old versions cached only the first minute of a scrape and then treated those rows as final.
 * Walk the complete NEWEST chain and merge unknown ids so those partial caches heal themselves.
 */
async function backfillHistory(job: Job, packageName: string, lang: string): Promise<void> {
  const known = new Set(job.reviews.map((review) => review.id));
  const pendingWrites: Promise<unknown>[] = [];
  let lastAnalyticsAt = 0;

  emitStage(
    job,
    'downloading-reviews',
    `Completing review history... (${job.reviews.length.toLocaleString()} stored)`,
    35,
  );

  const outcome = await fetchReviews(packageName, lang, job.reviewCountry, (scannedCount, batch) => {
    const unknown = batch.filter((review) => !known.has(review.id));
    if (unknown.length > 0) {
      for (const review of unknown) known.add(review.id);
      job.reviews.push(...unknown);
      job.events.emit('reviews', unknown);
      if (isStoreEnabled()) {
        pendingWrites.push(saveReviews(packageName, unknown).catch((e: Error) => console.error('[db] save:', e.message)));
      }
    }

    const progress = 35 + (1 - Math.exp(-scannedCount / 25_000)) * 45;
    emitStage(
      job,
      'downloading-reviews',
      `Completing review history... (${job.reviews.length.toLocaleString()} collected)`,
      progress,
    );

    if (unknown.length > 0 && Date.now() - lastAnalyticsAt >= ANALYTICS_INTERVAL_MS) {
      lastAnalyticsAt = Date.now();
      job.analytics = computeAnalytics(job.reviews);
      job.events.emit('analytics', job.analytics);
    }
  });

  await Promise.all(pendingWrites);
  job.reviewsComplete = outcome.complete;
  job.reviewStopReason = outcome.stopReason;
}

/**
 * Everything already in the database is emitted up front, so a previously fetched app is on screen
 * in well under a second. Only then does it go to Google, and only for reviews it doesn't have.
 */
async function serveFromStore(job: Job, packageName: string, lang: string, country: string): Promise<boolean> {
  const stored = await withReadBudget(loadApp(packageName), `loadApp(${packageName})`);
  if (!stored || stored.reviewCount === 0) return false;

  const reviews = await withReadBudget(loadReviews(packageName), `loadReviews(${packageName})`);
  // nothing has been emitted yet, so bailing here leaves the caller free to scrape normally
  if (!reviews) return false;

  job.app = stored.app;
  job.reviewCountry = stored.reviewCountry ?? country;
  job.reviewsComplete = stored.reviewsComplete;
  job.reviewStopReason = (stored.reviewStopReason as ReviewFetchStopReason | null) ?? 'partial-error';
  job.events.emit('app', stored.app);

  job.reviews = reviews;
  job.events.emit('reviews', job.reviews);

  job.analytics = computeAnalytics(job.reviews);
  job.events.emit('analytics', job.analytics);

  // The dashboard is fully usable from here. `complete` is deliberately held back until the
  // catch-up finishes: it is what closes the SSE channel, and firing it now would cut off the
  // new reviews the sync is about to emit. The client is already rendering off what it has.
  job.stage = 'downloading-reviews';
  job.message = `${stored.reviewCount.toLocaleString()} stored — checking for new reviews...`;
  job.progress = 92;
  job.events.emit('stage', job.stage, job.message, job.progress, job.reviews.length);

  await catchUp(job, packageName, lang, job.reviewCountry);
  if (!job.reviewsComplete) await backfillHistory(job, packageName, lang);

  job.analytics = computeAnalytics(job.reviews);
  job.events.emit('analytics', job.analytics);

  await finish(job, packageName);
  return true;
}

async function run(job: Job, rawUrl: string): Promise<void> {
  try {
    const { packageName, lang, country } = parsePlayStoreUrl(rawUrl);

    // Disk first: a previously fetched app comes back in ~50ms, which is the only path in this
    // whole pipeline that is genuinely instant. Network stores are checked only after it misses.
    const cached = getCachedResult(packageName);
    if (cached && cached.reviews.length > 0) {
      job.app = cached.app;
      job.reviews = cached.reviews;
      job.analytics = cached.analytics;
      job.reviewCountry = cached.reviewCollection?.country ?? country;
      job.reviewsComplete = cached.reviewCollection?.complete ?? false;
      job.reviewStopReason = cached.reviewCollection?.stopReason ?? 'partial-error';
      job.events.emit('app', cached.app);
      job.events.emit('reviews', cached.reviews);
      job.events.emit('analytics', cached.analytics);

      emitStage(job, 'downloading-reviews', `${cached.reviews.length.toLocaleString()} cached — checking for new reviews...`, 92);
      await catchUp(job, packageName, lang, job.reviewCountry);
      if (!job.reviewsComplete) await backfillHistory(job, packageName, lang);
      job.analytics = computeAnalytics(job.reviews);
      job.events.emit('analytics', job.analytics);
      await finish(job, packageName);
      return;
    }

    if (storeUsable()) {
      emitStage(job, 'preparing', 'Loading stored reviews...', 60);
      if (await serveFromStore(job, packageName, lang, country)) return;
    }

    emitStage(job, 'connecting', 'Connecting to Google Play...', 8);
    emitStage(job, 'app-details', 'Fetching application details...', 20);

    const { app, country: resolvedCountry } = await fetchAppDetails(packageName, lang, country);
    job.app = app;
    job.reviewCountry = resolvedCountry;
    job.events.emit('app', app);
    await saveApp(packageName, app, {
      country: resolvedCountry,
      complete: false,
      stopReason: 'partial-error',
    }).catch((e: Error) => console.error('[db] saveApp:', e.message));

    emitStage(job, 'downloading-reviews', 'Downloading reviews (newest first)...', 30);

    let lastAnalyticsAt = 0;
    // persisted as they arrive, so a fetch cut short by the timeout or a restart still leaves the
    // database better off than it was
    const pendingWrites: Promise<unknown>[] = [];

    const outcome = await fetchReviews(packageName, lang, resolvedCountry, (count, batch) => {
      if (batch.length === 0) return;
      job.reviews.push(...batch);
      job.events.emit('reviews', batch);
      if (isStoreEnabled()) {
        pendingWrites.push(saveReviews(packageName, batch).catch((e: Error) => console.error('[db] save:', e.message)));
      }

      // with no count cap the total is unknown, so ease toward the end of the 30-80 band
      const progress = 30 + (1 - Math.exp(-count / 15_000)) * 50;
      emitStage(job, 'downloading-reviews', `Downloading reviews... (${count.toLocaleString()} fetched)`, progress);

      // refreshing analytics mid-flight is what lets the dashboard render charts before the
      // fetch finishes; throttled so a long run doesn't spend all its time recomputing
      if (Date.now() - lastAnalyticsAt >= ANALYTICS_INTERVAL_MS) {
        lastAnalyticsAt = Date.now();
        job.analytics = computeAnalytics(job.reviews);
        job.events.emit('analytics', job.analytics);
      }
    });
    job.reviewsComplete = outcome.complete;
    job.reviewStopReason = outcome.stopReason;

    emitStage(job, 'analytics', 'Generating analytics...', 88);
    job.analytics = computeAnalytics(job.reviews);
    job.events.emit('analytics', job.analytics);

    emitStage(job, 'preparing', 'Preparing dashboard...', 96);
    await Promise.all(pendingWrites);

    await finish(job, packageName);
  } catch (error) {
    job.status = 'error';
    job.error = toJobError(error);
    job.events.emit('failed', job.error);
  } finally {
    // keep the finished job around briefly so a client that reconnects still sees the outcome
    setTimeout(() => {
      if (jobs.get(job.packageName) === job) jobs.delete(job.packageName);
    }, 60_000).unref();
  }
}

/**
 * Starts a fetch detached from any request, or returns the one already running for this app.
 * Deduplicating on package name means two tabs asking for the same app share a single scrape.
 */
export function startJob(rawUrl: string): Job {
  const { packageName } = parsePlayStoreUrl(rawUrl);

  const existing = jobs.get(packageName);
  if (existing && existing.status === 'running') return existing;

  const job: Job = {
    packageName,
    status: 'running',
    app: null,
    reviews: [],
    analytics: null,
    stage: 'connecting',
    message: 'Connecting to Google Play...',
    progress: 4,
    error: null,
    reviewCountry: 'us',
    reviewsComplete: false,
    reviewStopReason: 'partial-error',
    startedAt: Date.now(),
    // one listener per connected client; the default cap of 10 would warn on a busy app
    events: new EventEmitter().setMaxListeners(0),
  };
  jobs.set(packageName, job);

  // deliberately not awaited: the caller returns immediately and the work continues
  void run(job, rawUrl);
  return job;
}

export function getJob(packageName: string): Job | null {
  return jobs.get(packageName) ?? null;
}

/**
 * Attaches to a job, first replaying everything it has already produced so a client that connects
 * late (or reconnects) still receives the full picture, then forwarding live updates.
 */
export function subscribe(job: Job, handlers: JobHandlers): () => void {
  if (job.app) handlers.onApp(job.app);
  if (job.reviews.length > 0) handlers.onReviews(job.reviews);
  if (job.analytics) handlers.onAnalytics(job.analytics);
  handlers.onStage(job.stage, job.message, job.progress, job.reviews.length);

  if (job.status === 'complete') {
    handlers.onComplete(job.packageName, job.reviews.length);
    return () => {};
  }
  if (job.status === 'error' && job.error) {
    handlers.onError(job.error);
    return () => {};
  }

  const onStage = handlers.onStage;
  const onApp = handlers.onApp;
  const onReviews = handlers.onReviews;
  const onAnalytics = handlers.onAnalytics;
  const onComplete = handlers.onComplete;
  const onFailed = handlers.onError;

  job.events.on('stage', onStage);
  job.events.on('app', onApp);
  job.events.on('reviews', onReviews);
  job.events.on('analytics', onAnalytics);
  job.events.on('complete', onComplete);
  job.events.on('failed', onFailed);

  return () => {
    job.events.off('stage', onStage);
    job.events.off('app', onApp);
    job.events.off('reviews', onReviews);
    job.events.off('analytics', onAnalytics);
    job.events.off('complete', onComplete);
    job.events.off('failed', onFailed);
  };
}

/** Runs a fetch to completion — used by the non-streaming POST endpoint. */
export async function runToCompletion(rawUrl: string): Promise<ReviewFetchResult> {
  const job = startJob(rawUrl);

  if (job.status === 'running') {
    await new Promise<void>((resolve, reject) => {
      job.events.once('complete', () => resolve());
      job.events.once('failed', (error: JobError) => reject(new AppError(error.code as never, error.message)));
    });
  }
  if (job.status === 'error' && job.error) {
    throw new AppError(job.error.code as never, job.error.message);
  }

  return {
    packageName: job.packageName,
    app: job.app!,
    reviews: job.reviews,
    analytics: job.analytics!,
    fetchedAt: new Date().toISOString(),
  };
}

/** Cheap introspection for /api/health/metrics. */
export function jobStats(): { active: number; running: string[] } {
  const running = [...jobs.values()].filter((job) => job.status === 'running').map((job) => job.packageName);
  return { active: running.length, running };
}
