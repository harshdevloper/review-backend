export type ErrorCode =
  | 'INVALID_URL'
  | 'APP_NOT_FOUND'
  | 'SCRAPE_FAILED'
  | 'RATE_LIMITED'
  | 'NOT_CACHED'
  | 'VALIDATION_ERROR';

const SUGGESTIONS: Record<ErrorCode, string> = {
  INVALID_URL:
    'Paste a full Google Play Store app URL, e.g. https://play.google.com/store/apps/details?id=com.whatsapp',
  APP_NOT_FOUND:
    'Double-check the app id. If the app is published in only a few countries, add that storefront to the URL, e.g. &gl=in.',
  SCRAPE_FAILED:
    'Google Play may be temporarily unavailable. Wait a few seconds and try again.',
  RATE_LIMITED:
    'Too many requests right now. Wait a minute before trying again.',
  NOT_CACHED:
    'This app has not been fetched recently. Fetch it again to view the dashboard.',
  VALIDATION_ERROR: 'Check the request and try again.',
};

export class AppError extends Error {
  code: ErrorCode;
  status: number;
  suggestion: string;

  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.suggestion = SUGGESTIONS[code];
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const err = error as { status?: number; message?: string } | undefined;
  if (err?.status === 404) {
    return new AppError('APP_NOT_FOUND', 'This app could not be found on the Google Play Store.', 404);
  }
  if (err?.status === 429) {
    return new AppError('RATE_LIMITED', 'Google Play is rate-limiting requests right now.', 429);
  }

  return new AppError(
    'SCRAPE_FAILED',
    err?.message ?? 'Failed to fetch data from the Google Play Store.',
    502,
  );
}
