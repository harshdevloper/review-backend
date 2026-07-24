import gplay from 'google-play-scraper';
import { env } from '../config/env.js';
import { detectLanguage } from '../utils/language.js';
import { toAppError } from '../utils/errors.js';
import type { AppDetails } from '../types/app.types.js';
import type { Review, Sentiment } from '../types/review.types.js';

const REVIEWS_PER_PAGE = 200;
// google-play-scraper's .d.ts mistypes `gplay.sort` as the enum's value type
// instead of its namespace, so `gplay.sort.NEWEST` doesn't type-check. The
// enum itself declares NEWEST = 2 — use that literal instead.
const SORT_NEWEST = 2;

export async function fetchAppDetails(
  packageName: string,
  lang: string,
  country: string,
): Promise<AppDetails> {
  try {
    const app = await gplay.app({ appId: packageName, lang, country });

    return {
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
  } catch (error) {
    throw toAppError(error);
  }
}

function scoreToSentiment(score: number): Sentiment {
  if (score >= 4) return 'positive';
  if (score === 3) return 'neutral';
  return 'negative';
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
      const page = await gplay.reviews({
        appId: packageName,
        sort: SORT_NEWEST,
        num: REVIEWS_PER_PAGE,
        paginate: true,
        nextPaginationToken: token,
      });

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
