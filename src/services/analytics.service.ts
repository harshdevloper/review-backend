import { STOPWORDS } from '../utils/stopwords.js';
import type { Review, Analytics, RatingDistribution } from '../types/review.types.js';

const WORD_RE = /[a-zA-Z']+/g;
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function computeRatingDistribution(reviews: Review[]): RatingDistribution {
  const dist: RatingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) {
    const bucket = Math.min(5, Math.max(1, Math.round(r.score))) as 1 | 2 | 3 | 4 | 5;
    dist[bucket] += 1;
  }
  return dist;
}

function computeSentiment(reviews: Review[]) {
  const sentiment = { positive: 0, neutral: 0, negative: 0 };
  for (const r of reviews) sentiment[r.sentiment] += 1;
  return sentiment;
}

function computeTimeline(reviews: Review[]) {
  const buckets = new Map<string, { label: string; count: number; total: number }>();

  for (const r of reviews) {
    const d = new Date(r.date);
    if (Number.isNaN(d.getTime())) continue;
    const sortKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const label = `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const existing = buckets.get(sortKey) ?? { label, count: 0, total: 0 };
    existing.count += 1;
    existing.total += r.score;
    buckets.set(sortKey, existing);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({
      month: v.label,
      count: v.count,
      avgRating: Number((v.total / v.count).toFixed(2)),
    }));
}

function computeVersionBreakdown(reviews: Review[]) {
  const counts = new Map<string, number>();
  for (const r of reviews) {
    const v = r.version ?? 'Unknown';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

function computeHeatmap(reviews: Review[]) {
  const grid = new Map<string, number>();
  for (const r of reviews) {
    const d = new Date(r.date);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getUTCDay()}-${d.getUTCHours()}`;
    grid.set(key, (grid.get(key) ?? 0) + 1);
  }

  const points: { day: number; hour: number; count: number }[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      points.push({ day, hour, count: grid.get(`${day}-${hour}`) ?? 0 });
    }
  }
  return points;
}

function computeTopKeywords(reviews: Review[]) {
  const counts = new Map<string, number>();
  for (const r of reviews) {
    if (r.language !== 'English' && r.language !== 'Unknown') continue;
    const words = r.text.toLowerCase().match(WORD_RE) ?? [];
    for (const w of words) {
      const clean = w.replace(/'/g, '');
      if (clean.length < 3 || STOPWORDS.has(clean)) continue;
      counts.set(clean, (counts.get(clean) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 60);
}

function computeAvgReviewLength(reviews: Review[]) {
  if (reviews.length === 0) return 0;
  const total = reviews.reduce((sum, r) => sum + r.text.split(/\s+/).filter(Boolean).length, 0);
  return Number((total / reviews.length).toFixed(1));
}

function computeDeveloperReplyPercentage(reviews: Review[]) {
  if (reviews.length === 0) return 0;
  const withReply = reviews.filter((r) => Boolean(r.replyText)).length;
  return Number(((withReply / reviews.length) * 100).toFixed(1));
}

function computeLanguageDistribution(reviews: Review[]) {
  const counts = new Map<string, number>();
  for (const r of reviews) counts.set(r.language, (counts.get(r.language) ?? 0) + 1);
  return [...counts.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => b.count - a.count);
}

export function computeAnalytics(reviews: Review[]): Analytics {
  return {
    ratingDistribution: computeRatingDistribution(reviews),
    sentiment: computeSentiment(reviews),
    timeline: computeTimeline(reviews),
    versionBreakdown: computeVersionBreakdown(reviews),
    heatmap: computeHeatmap(reviews),
    topKeywords: computeTopKeywords(reviews),
    avgReviewLength: computeAvgReviewLength(reviews),
    developerReplyPercentage: computeDeveloperReplyPercentage(reviews),
    languageDistribution: computeLanguageDistribution(reviews),
  };
}
