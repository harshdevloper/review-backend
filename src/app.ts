import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.route.js';
import { reviewsRouter } from './routes/reviews.route.js';
import { exportRouter } from './routes/export.route.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

// Vercel gives every preview/branch deploy its own *.vercel.app subdomain, so
// allow the whole family in addition to the explicit allowlist.
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

function isAllowedOrigin(origin: string): boolean {
  return env.clientOrigins.includes(origin) || VERCEL_PREVIEW_RE.test(origin);
}

export function createApp() {
  const app = express();

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(
    cors({
      origin(origin, callback) {
        // allow same-origin / non-browser requests (no Origin header) and any
        // origin in the allowlist (or a Vercel preview deploy)
        if (!origin || isAllowedOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed by CORS`));
      },
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '25mb' }));

  app.use('/api/health', healthRouter);
  app.use('/api/reviews', reviewsRouter);
  app.use('/api/export', exportRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
