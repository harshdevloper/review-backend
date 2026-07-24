import { env } from '../config/env.js';
import type { ReviewFetchResult } from '../types/review.types.js';

interface CacheEntry {
  value: ReviewFetchResult;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

export function setCachedResult(packageName: string, value: ReviewFetchResult): void {
  store.set(packageName, {
    value,
    expiresAt: Date.now() + env.cacheTtlMinutes * 60_000,
  });
}

export function getCachedResult(packageName: string): ReviewFetchResult | null {
  const entry = store.get(packageName);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(packageName);
    return null;
  }
  return entry.value;
}
