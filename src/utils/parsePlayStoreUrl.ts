import { AppError } from './errors.js';

const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export interface ParsedPlayStoreUrl {
  packageName: string;
  lang: string;
  country: string;
}

export function parsePlayStoreUrl(input: string): ParsedPlayStoreUrl {
  const raw = input.trim();
  if (!raw) {
    throw new AppError('INVALID_URL', 'Please paste a Google Play Store app URL.');
  }

  let packageName: string | null = null;
  let lang = 'en';
  let country = 'us';

  try {
    const url = new URL(raw);
    const isPlayStoreHost = /(^|\.)play\.google\.com$/i.test(url.hostname);
    if (isPlayStoreHost && url.pathname.includes('/store/apps/details')) {
      packageName = url.searchParams.get('id');
      lang = url.searchParams.get('hl') ?? lang;
      country = url.searchParams.get('gl') ?? country;
    }
  } catch {
    // not a URL — fall through to bare package name check below
  }

  if (!packageName && PACKAGE_NAME_RE.test(raw)) {
    packageName = raw;
  }

  if (!packageName || !PACKAGE_NAME_RE.test(packageName)) {
    throw new AppError(
      'INVALID_URL',
      'That does not look like a valid Google Play Store app URL.',
    );
  }

  return { packageName, lang, country };
}
