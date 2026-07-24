import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  cacheTtlMinutes: Number(process.env.CACHE_TTL_MINUTES ?? 30),
  maxReviews: Number(process.env.MAX_REVIEWS ?? 2000),
};
