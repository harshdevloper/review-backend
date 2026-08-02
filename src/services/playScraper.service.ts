import gplay from 'google-play-scraper';
import { env } from '../config/env.js';
import { detectLanguage } from '../utils/language.js';
import { AppError, toAppError } from '../utils/errors.js';
import type { AppDetails } from '../types/app.types.js';
import type { Review, Sentiment } from '../types/review.types.js';

// Google caps a review page at ~150 entries no matter what `num` asks for, so reaching 10k takes
// roughly 67 round trips.
const REVIEWS_PER_PAGE = 200;
// google-play-scraper's .d.ts mistypes `gplay.sort` as the enum's value type instead of its
// namespace, so `gplay.sort.NEWEST` doesn't type-check. The enum declares HELPFULNESS = 1,
// NEWEST = 2, RATING = 3 — use those literals instead.
//
// Each sort order is its own paginated feed and they barely overlap: fetching only NEWEST shares
// 0% of its results with HELPFULNESS, which is what the Play Store page itself shows by default —
// so a newest-only fetch looks nothing like the store listing. Walking every order and merging on
// review id both matches what users see and reaches far more reviews than any single feed.
const REVIEW_SORTS = [
  { name: 'relevant', value: 1 },
  { name: 'newest', value: 2 },
  { name: 'rating', value: 3 },
];
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
): Promise<Review[]> {
  const byId = new Map<string, Review>();
  const limit = env.maxReviews > 0 ? env.maxReviews : Infinity;
  const deadline = env.fetchTimeoutMs > 0 ? Date.now() + env.fetchTimeoutMs : Infinity;
  const budgetSpent = () => byId.size >= limit || Date.now() >= deadline;

  const walkSort = async (sort: number): Promise<void> => {
    let token: string | undefined;

    for (;;) {
      const page = await fetchReviewPage(packageName, lang, country, sort, token, deadline);

      const batch: Review[] = [];
      for (const item of page.data) {
        if (byId.has(item.id)) continue;
        const review = toReview(item, lang);
        byId.set(item.id, review);
        batch.push(review);
      }

      token = page.nextPaginationToken;
      onProgress?.(byId.size, batch);

      if (!token || budgetSpent()) return;
      await sleep(PAGE_DELAY_MS);
    }
  };

  // The sort feeds are independent pagination chains, so walking them at the same time fits about
  // 30% more reviews into the same wall clock. It is not 3x: Google throttles on total request
  // rate, and dropping the per-chain delay to zero gets every request rejected outright — the
  // delay is what keeps the whole thing alive, so it stays even when running concurrently.
  const outcomes = await Promise.allSettled(REVIEW_SORTS.map(({ value }) => walkSort(value)));

  // one feed running dry shouldn't lose what the others produced; only a total washout is an error
  if (byId.size === 0) {
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    throw toAppError(failed?.reason ?? new Error('Google Play returned no reviews for this app.'));
  }

  const collected = [...byId.values()];
  return limit === Infinity ? collected : collected.slice(0, limit);
}
