import gplay from 'google-play-scraper';
import { env } from '../config/env.js';
import { detectLanguage } from '../utils/language.js';
import { AppError, toAppError } from '../utils/errors.js';
import type { AppDetails } from '../types/app.types.js';
import type { Review, Sentiment } from '../types/review.types.js';

// Google caps a review page at ~150 entries no matter what `num` asks for, so reaching 10k takes
// roughly 67 round trips.
const REVIEWS_PER_PAGE = 200;
// google-play-scraper's .d.ts mistypes `gplay.sort` as the enum's value type
// instead of its namespace, so `gplay.sort.NEWEST` doesn't type-check. The
// enum itself declares NEWEST = 2 — use that literal instead.
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
  token: string | undefined,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gplay.reviews({
        appId: packageName,
        lang,
        country,
        sort: SORT_NEWEST,
        num: REVIEWS_PER_PAGE,
        paginate: true,
        nextPaginationToken: token,
      });
    } catch (error) {
      // a 404 mid-pagination is terminal; resets and rate limits are worth backing off for
      if (attempt >= MAX_PAGE_RETRIES || statusOf(error) === 404) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export async function fetchReviews(
  packageName: string,
  lang: string,
  country: string,
  onProgress?: (count: number) => void,
): Promise<Review[]> {
  const collected: Review[] = [];
  let token: string | undefined;

  try {
    do {
      const page = await fetchReviewPage(packageName, lang, country, token);

      for (const item of page.data) {
        const text = item.text ?? '';
        collected.push({
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
        });
      }

      token = page.nextPaginationToken;
      onProgress?.(collected.length);

      if (token && collected.length < env.maxReviews) await sleep(PAGE_DELAY_MS);
    } while (token && collected.length < env.maxReviews);
  } catch (error) {
    if (collected.length > 0) {
      // partial results are still useful — surface what we have instead of failing the whole fetch
      return collected.slice(0, env.maxReviews);
    }
    throw toAppError(error);
  }

  return collected.slice(0, env.maxReviews);
}
