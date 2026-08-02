import { gzip, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../config/env.js';
import type { ReviewFetchResult } from '../types/review.types.js';

const gzipAsync = promisify(gzip);

/**
 * Entries are held as the gzipped bytes rather than as parsed objects. Two reasons, both measured
 * on a 16,482-review app:
 *
 *  - Serving: those bytes go straight to the wire, so a cached response costs a 2.9ms buffer copy
 *    instead of gunzip(69ms) + parse(55ms) + stringify(62ms) + gzip(295ms) — ~480ms of synchronous
 *    CPU during which the process could serve nobody else.
 *  - Memory: 2.07 MB compressed against 7.5 MB of JSON, before the object overhead of 16k parsed
 *    review objects on top of that.
 *
 * Anything that genuinely needs the objects (the catch-up sync) pays the parse on demand, which is
 * once per fetch rather than once per request.
 */
interface CacheEntry {
  gzip: Buffer;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

// Local disk is by far the fastest place to keep a fetched app: 50ms to read one back, against 71s
// from a remote database and ~62s to scrape it again. It also survives a restart, which the
// in-memory map alone never could.
const CACHE_DIR = join(process.cwd(), '.cache');
let diskReady = false;

function ensureDir(): boolean {
  if (diskReady) return true;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    diskReady = true;
  } catch (error) {
    console.warn('[cache] disk cache unavailable:', (error as Error).message);
  }
  return diskReady;
}

// package names are dotted ascii, but never trust one straight into a path
function fileFor(packageName: string): string {
  return join(CACHE_DIR, `${packageName.replace(/[^a-zA-Z0-9._-]/g, '_')}.json.gz`);
}

function readGzipFromDisk(packageName: string): Buffer | null {
  if (!ensureDir()) return null;
  const file = fileFor(packageName);
  if (!existsSync(file)) return null;

  try {
    if (Date.now() - statSync(file).mtimeMs > env.diskCacheTtlMinutes * 60_000) {
      unlinkSync(file);
      return null;
    }
    return readFileSync(file);
  } catch (error) {
    console.warn(`[cache] discarding unreadable ${packageName}:`, (error as Error).message);
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
    return null;
  }
}

/** Wire-ready gzipped JSON, or null. Callers send this verbatim with `Content-Encoding: gzip`. */
export function getCachedBuffer(packageName: string): Buffer | null {
  const entry = store.get(packageName);
  if (entry && Date.now() <= entry.expiresAt) return entry.gzip;
  if (entry) store.delete(packageName);

  const fromDisk = readGzipFromDisk(packageName);
  if (fromDisk) {
    store.set(packageName, { gzip: fromDisk, expiresAt: Date.now() + env.cacheTtlMinutes * 60_000 });
    return fromDisk;
  }
  return null;
}

/** Parsed form, for callers that need the objects. Costs ~124ms on a 16k-review app — avoid on the serve path. */
export function getCachedResult(packageName: string): ReviewFetchResult | null {
  const buffer = getCachedBuffer(packageName);
  if (!buffer) return null;
  try {
    return JSON.parse(gunzipSync(buffer).toString()) as ReviewFetchResult;
  } catch (error) {
    console.warn(`[cache] corrupt entry for ${packageName}:`, (error as Error).message);
    store.delete(packageName);
    return null;
  }
}

/**
 * Compression runs off the event loop: gzipping 7.5 MB synchronously blocks for ~295ms, which on
 * the fetch path would stall every in-flight SSE stream at exactly the moment they are busiest.
 */
export async function setCachedResult(packageName: string, value: ReviewFetchResult): Promise<void> {
  try {
    const buffer = await gzipAsync(Buffer.from(JSON.stringify(value)), { level: 6 });
    store.set(packageName, { gzip: buffer, expiresAt: Date.now() + env.cacheTtlMinutes * 60_000 });
    if (ensureDir()) writeFileSync(fileFor(packageName), buffer);
  } catch (error) {
    console.warn(`[cache] could not persist ${packageName}:`, (error as Error).message);
  }
}

/** Cheap introspection for /api/health/metrics — no payloads are decompressed. */
export function cacheStats(): { entries: number; bytes: number; packages: string[] } {
  let bytes = 0;
  for (const entry of store.values()) bytes += entry.gzip.byteLength;
  return { entries: store.size, bytes, packages: [...store.keys()] };
}
