import type { NextFunction, Request, Response } from 'express';
import { AppError, toAppError } from '../utils/errors.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: `No route for ${req.method} ${req.path}`,
  });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appError: AppError = toAppError(err);

  if (process.env.NODE_ENV !== 'test') {
    console.error(`[error] ${appError.code}:`, appError.message);
  }

  res.status(appError.status).json({
    code: appError.code,
    message: appError.message,
    suggestion: appError.suggestion,
  });
}
