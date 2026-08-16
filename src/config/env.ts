import 'dotenv/config';

// Origins always allowed by CORS. The deployed Vercel frontend is baked in so
// the app works out of the box; anything in CLIENT_ORIGIN (comma-separated) is
// merged on top for additional/self-hosted domains.
const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'https://review-frontend-three.vercel.app',
];

const envOrigins = (process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const env = {
  port: Number(process.env.PORT ?? 4000),
  clientOrigins: [...new Set([...DEFAULT_ORIGINS, ...envOrigins])],
  cacheTtlMinutes: Number(process.env.CACHE_TTL_MINUTES ?? 30),
  // How long a fetched app stays usable on disk. Much longer than the in-memory TTL: re-reading
  // it costs ~50ms, so serving a day-old copy instantly and refreshing behind it beats making
  // anyone wait a minute for a fresh scrape.
  diskCacheTtlMinutes: Number(process.env.DISK_CACHE_TTL_MINUTES ?? 60 * 24 * 7),
  // Optional. With it, reviews are stored once and served instantly on every later visit, and
  // refreshes only pull what's new. Without it the app still works, it just re-scrapes each time.
  databaseUrl: process.env.DATABASE_URL ?? '',
  // 0 = no cap: keep paginating every sort order until Google stops handing out pages.
  maxReviews: Number(process.env.MAX_REVIEWS ?? 0),
  // Optional safety budget. The default is deliberately unlimited: a non-zero timeout produces a
  // partial corpus and is reported as such, while 0 walks Google's NEWEST cursor to exhaustion.
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MINUTES ?? 0) * 60_000,
};
