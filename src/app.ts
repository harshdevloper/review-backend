import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.route.js';
import { reviewsRouter } from './routes/reviews.route.js';
import { exportRouter } from './routes/export.route.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cors({ origin: env.clientOrigin }));
  app.use(compression());
  app.use(express.json({ limit: '25mb' }));

  app.use('/api/health', healthRouter);
  app.use('/api/reviews', reviewsRouter);
  app.use('/api/export', exportRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
