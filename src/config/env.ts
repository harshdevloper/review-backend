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
  maxReviews: Number(process.env.MAX_REVIEWS ?? 2000),
};
