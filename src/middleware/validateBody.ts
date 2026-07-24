import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../utils/errors.js';

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new AppError('VALIDATION_ERROR', result.error.issues[0]?.message ?? 'Invalid request body.'));
      return;
    }
    req.body = result.data;
    next();
  };
}
