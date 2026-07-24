import { Router } from 'express';
import { streamReviews, postReviews, getCachedReviews, reviewsBodySchema } from '../controllers/reviews.controller.js';
import { validateBody } from '../middleware/validateBody.js';

export const reviewsRouter = Router();

reviewsRouter.get('/stream', streamReviews);
reviewsRouter.post('/', validateBody(reviewsBodySchema), postReviews);
reviewsRouter.get('/:packageName', getCachedReviews);
