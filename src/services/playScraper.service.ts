import gplay from 'google-play-scraper';
import { env } from '../config/env.js';
import { detectLanguage } from '../utils/language.js';
import { AppError, toAppError } from '../utils/errors.js';
import type { AppDetails } from '../types/app.types.js';
import type { Review, Sentiment } from '../types/review.types.js';

// Google currently caps a review page at 150 entries. Asking for more does not make the page
// larger, and makes the intended pagination contract less obvious.
const REVIEWS_PER_PAGE = 150;
// google-play-scraper's .d.ts mistypes `gplay.sort` as the enum's value type instead of its
// namespace. NEWEST is 2 in the library's public constants.
const SORT_NEWEST = 2;
// Requesting those pages back-to-back gets the connection torn down (ECONNRESET) after ~15 of
// them, which is what capped deep fetches. Pausing briefly between pages sustains the full run;
// the retry is a safety net for resets that still slip through.
const PAGE_DELAY_MS = 600;
const MAX_PAGE_RETRIES = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Play Store listings are per-storefront: an app distributed only in some markets returns 404 in
// every other one. Pasted URLs rarely carry a `gl` parameter, so the default `us` storefront
// reports perfectly healthy region-locked apps (Indian fintech, Chinese super-apps, …) as
// unpublished. These markets are swept before concluding an app really is gone.
const FALLBACK_COUNTRIES = ['us', 'in', 'br', 'id', 'jp', 'de', 'gb', 'ng'];

type PlayApp = Awaited<ReturnType<typeof gplay.app>>;
type PlayReview = Awaited<ReturnType<typeof gplay.reviews>>['data'][number];

export type ReviewFetchStopReason = 'exhausted' | 'limit' | 'timeout' | 'partial-error';

export interface ReviewFetchOutcome {
  reviewCount: number;
  complete: boolean;
  stopReason: ReviewFetchStopReason;
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | undefined)?.status;
}

/**
 * Finds a storefront that actually lists the app, starting with the one the URL asked for and
 * only then sweeping the major markets in parallel — the happy path stays a single request.
 */
async function resolveListing(
  packageName: string,
  lang: string,
  country: string,
): Promise<{ app: PlayApp; country: string }> {
  const lookup = async (gl: string) => ({ app: await gplay.app({ appId: packageName, lang, country: gl }), country: gl });

  try {
    return await lookup(country);
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }

  const candidates = FALLBACK_COUNTRIES.filter((gl) => gl !== country);
  const settled = await Promise.allSettled(candidates.map(lookup));
  const found = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));

  // A market the app isn't really distributed in can still serve a stub listing with no rating
  // data at all, so prefer a storefront that returned ratings over whichever answered first.
  const listing = found.find((r) => Number.isFinite(r.app.score)) ?? found[0];
  if (listing) return listing;

  const rejections = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  const notFoundEverywhere = rejections.every((error) => statusOf(error) === 404);
  if (!notFoundEverywhere) {
    throw rejections.find((error) => statusOf(error) !== 404);
  }

  throw new AppError('APP_NOT_FOUND', 'This app could not be found on the Google Play Store.', 404);
}

export async function fetchAppDetails(
  packageName: string,
  lang: string,
  country: string,
): Promise<{ app: AppDetails; country: string }> {
  try {
    const { app, country: resolvedCountry } = await resolveListing(packageName, lang, country);

    const details: AppDetails = {
      packageName: app.appId,
      url: app.url,
      title: app.title,
      summary: app.summary,
      description: app.description,
      icon: app.icon,
      headerImage: app.headerImage ?? null,
      screenshots: app.screenshots ?? [],
      developer: app.developer,
      developerId: app.developerId,
      developerWebsite: app.developerWebsite ?? null,
      category: app.genre,
      categoryId: app.genreId ?? null,
      version: app.version ?? 'Varies',
      installs: app.installs,
      minInstalls: app.minInstalls,
      maxInstalls: app.maxInstalls,
      score: app.score ?? 0,
      scoreText: app.scoreText ?? '0',
      ratings: app.ratings ?? 0,
      reviewsCount: app.reviews ?? 0,
      histogram: {
        '1': app.histogram?.['1'] ?? 0,
        '2': app.histogram?.['2'] ?? 0,
        '3': app.histogram?.['3'] ?? 0,
        '4': app.histogram?.['4'] ?? 0,
        '5': app.histogram?.['5'] ?? 0,
      },
      free: app.free,
      price: app.price,
      priceText: app.priceText,
      currency: app.currency,
      size: app.size,
      androidVersion: app.androidVersion,
      contentRating: app.contentRating,
      adSupported: Boolean(app.adSupported),
      released: app.released ?? null,
      updated: app.updated ? new Date(app.updated).toISOString() : null,
      recentChanges: app.recentChanges ?? null,
    };

    return { app: details, country: resolvedCountry };
  } catch (error) {
    throw toAppError(error);
  }
}

function scoreToSentiment(score: number): Sentiment {
  if (score >= 4) return 'positive';
  if (score === 3) return 'neutral';
  return 'negative';
}

async function fetchReviewPage(
  packageName: string,
  lang: string,
  country: string,
  sort: number,
  token: string | undefined,
  deadline: number,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gplay.reviews({
        appId: packageName,
        lang,
        country,
        sort,
        num: REVIEWS_PER_PAGE,
        paginate: true,
        nextPaginationToken: token,
      });
    } catch (error) {
      // a 404 mid-pagination is terminal; resets and rate limits are worth backing off for
      if (attempt >= MAX_PAGE_RETRIES || statusOf(error) === 404) throw error;
      const backoff = 1000 * 2 ** attempt;
      // never let a backoff run past the caller's wall clock — on a short budget the last retry
      // would otherwise overshoot it by more than it could earn back
      if (Date.now() + backoff >= deadline) throw error;
      await sleep(backoff);
    }
  }
}

function toReview(item: PlayReview, lang: string): Review {
  const text = item.text ?? '';
  return {
    id: item.id,
    userName: item.userName,
    userImage: item.userImage,
    score: item.score,
    title: item.title ?? null,
    text,
    date: item.date,
    replyDate: item.replyDate ?? null,
    replyText: item.replyText ?? null,
    version: item.version ?? null,
    thumbsUp: item.thumbsUp ?? 0,
    language: detectLanguage(text, lang),
    sentiment: scoreToSentiment(item.score),
  };
}

/**
 * Pulls only reviews that aren't stored yet. Google returns the NEWEST feed most-recent-first, so
 * everything new sits at the front: page forward until a page contains nothing unknown, then stop.
 * Catching up on a day of activity costs a couple of requests instead of a full re-scrape.
 *
 * `isKnown` reports which ids are already held; the walk tolerates a few pages that are entirely
 * known before giving up, since the feed is not perfectly ordered near the boundary.
 */
export async function syncNewReviews(
  packageName: string,
  lang: string,
  country: string,
  findUnknown: (ids: string[]) => Promise<Set<string>>,
  onBatch?: (batch: Review[]) => void,
): Promise<Review[]> {
  const SORT_NEWEST = 2;
  const STOP_AFTER_KNOWN_PAGES = 2;
  const deadline = env.fetchTimeoutMs > 0 ? Date.now() + env.fetchTimeoutMs : Infinity;

  const fresh: Review[] = [];
  let token: string | undefined;
  let knownPages = 0;

  for (;;) {
    const page = await fetchReviewPage(packageName, lang, country, SORT_NEWEST, token, deadline);
    if (page.data.length === 0) break;

    const unknown = await findUnknown(page.data.map((item) => item.id));
    if (unknown.size === 0) {
      if (++knownPages >= STOP_AFTER_KNOWN_PAGES) break;
    } else {
      knownPages = 0;
      const batch = page.data.filter((item) => unknown.has(item.id)).map((item) => toReview(item, lang));
      fresh.push(...batch);
      onBatch?.(batch);
    }

    token = page.nextPaginationToken;
    if (!token || Date.now() >= deadline) break;
    await sleep(PAGE_DELAY_MS);
  }

  return fresh;
}

export async function fetchReviews(
  packageName: string,
  lang: string,
  country: string,
  // `batch` carries only the reviews new to this page, so a consumer can stream results out as
  // they land instead of waiting for the whole run to finish
  onProgress?: (count: number, batch: Review[]) => void,
): Promise<ReviewFetchOutcome> {
  const byId = new Map<string, Review>();
  const limit = env.maxReviews > 0 ? env.maxReviews : Infinity;
  const deadline = env.fetchTimeoutMs > 0 ? Date.now() + env.fetchTimeoutMs : Infinity;
  const seenTokens = new Set<string>();
  let token: string | undefined;

  try {
    for (;;) {
      if (Date.now() >= deadline) {
        return { reviewCount: byId.size, complete: false, stopReason: 'timeout' };
      }

      const page = await fetchReviewPage(packageName, lang, country, SORT_NEWEST, token, deadline);
      const batch: Review[] = [];

      for (const item of page.data) {
        if (byId.has(item.id)) continue;
        const review = toReview(item, lang);
        byId.set(item.id, review);
        batch.push(review);
        if (byId.size >= limit) break;
      }

      onProgress?.(byId.size, batch);

      // An empty continuation page is Google Play's normal end-of-results signal. Treat it as
      // exhaustion even if the response happens to repeat the previous token.
      if (page.data.length === 0 || !page.nextPaginationToken) {
        return { reviewCount: byId.size, complete: true, stopReason: 'exhausted' };
      }
      if (byId.size >= limit) {
        return { reviewCount: byId.size, complete: false, stopReason: 'limit' };
      }

      token = page.nextPaginationToken;
      // A repeated cursor would otherwise loop forever and keep returning the same page.
      if (seenTokens.has(token)) {
        return { reviewCount: byId.size, complete: false, stopReason: 'partial-error' };
      }
      seenTokens.add(token);

      if (Date.now() + PAGE_DELAY_MS >= deadline) {
        return { reviewCount: byId.size, complete: false, stopReason: 'timeout' };
      }
      await sleep(PAGE_DELAY_MS);
    }
  } catch (error) {
    // Preserve useful pages when a deep pagination request eventually gets throttled or reset.
    // The caller records the result as partial, so the next visit backfills instead of mistaking
    // it for a complete corpus. An initial-page failure still surfaces as a real request failure.
    if (byId.size === 0) throw toAppError(error);
    return { reviewCount: byId.size, complete: false, stopReason: 'partial-error' };
  }
}
