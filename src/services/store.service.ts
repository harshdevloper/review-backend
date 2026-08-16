import { getPool, isStoreEnabled } from '../db/pool.js';
import type { AppDetails } from '../types/app.types.js';
import type { Review } from '../types/review.types.js';

// Rows per INSERT. Postgres caps a statement at 65535 bound parameters; UNNEST passes four arrays
// regardless of row count, so this is about keeping each round trip a sane size, not a hard limit.
const INSERT_CHUNK = 1000;

export interface StoredApp {
  app: AppDetails;
  syncedAt: string;
  reviewCount: number;
  reviewCountry: string | null;
  reviewsComplete: boolean;
  reviewStopReason: string | null;
}

export interface ReviewSyncState {
  country: string;
  complete: boolean;
  stopReason: string;
}

export async function loadApp(packageName: string): Promise<StoredApp | null> {
  if (!isStoreEnabled()) return null;

  const { rows } = await getPool().query<{
    details: AppDetails;
    synced_at: Date;
    review_count: string;
    review_country: string | null;
    reviews_complete: boolean;
    review_stop_reason: string | null;
  }>(
    `SELECT a.details,
            a.synced_at,
            a.review_country,
            a.reviews_complete,
            a.review_stop_reason,
            (SELECT count(*) FROM reviews r WHERE r.package_name = a.package_name) AS review_count
       FROM apps a
      WHERE a.package_name = $1`,
    [packageName],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    app: row.details,
    syncedAt: row.synced_at.toISOString(),
    reviewCount: Number(row.review_count),
    reviewCountry: row.review_country,
    reviewsComplete: row.reviews_complete,
    reviewStopReason: row.review_stop_reason,
  };
}

export async function loadReviews(packageName: string): Promise<Review[]> {
  if (!isStoreEnabled()) return [];

  const { rows } = await getPool().query<{ data: Review }>(
    `SELECT data FROM reviews
      WHERE package_name = $1
      ORDER BY posted_at DESC NULLS LAST`,
    [packageName],
  );
  return rows.map((row) => row.data);
}

export async function saveApp(packageName: string, app: AppDetails, sync?: ReviewSyncState): Promise<void> {
  if (!isStoreEnabled()) return;

  await getPool().query(
    `INSERT INTO apps (
       package_name, details, synced_at, review_country, reviews_complete, review_stop_reason
     ) VALUES ($1, $2, now(), $3, COALESCE($4::boolean, false), $5)
     ON CONFLICT (package_name)
       DO UPDATE SET details = EXCLUDED.details,
                     synced_at = now(),
                     review_country = COALESCE(EXCLUDED.review_country, apps.review_country),
                     reviews_complete = COALESCE($4::boolean, apps.reviews_complete),
                     review_stop_reason = COALESCE(EXCLUDED.review_stop_reason, apps.review_stop_reason)`,
    [packageName, JSON.stringify(app), sync?.country ?? null, sync?.complete ?? null, sync?.stopReason ?? null],
  );
}

/** Bulk upsert. Existing rows are refreshed too, because users can edit reviews and developers reply later. */
export async function saveReviews(packageName: string, reviews: Review[]): Promise<number> {
  if (!isStoreEnabled() || reviews.length === 0) return 0;

  const pool = getPool();
  let inserted = 0;

  for (let offset = 0; offset < reviews.length; offset += INSERT_CHUNK) {
    const chunk = reviews.slice(offset, offset + INSERT_CHUNK);
    const ids = chunk.map((r) => r.id);
    const dates = chunk.map((r) => {
      const time = new Date(r.date).getTime();
      return Number.isNaN(time) ? null : new Date(time).toISOString();
    });
    const payloads = chunk.map((r) => JSON.stringify(r));

    const { rowCount } = await pool.query(
      `INSERT INTO reviews (package_name, id, posted_at, data)
       SELECT $1, * FROM UNNEST($2::text[], $3::timestamptz[], $4::jsonb[])
       ON CONFLICT (package_name, id)
       DO UPDATE SET posted_at = EXCLUDED.posted_at, data = EXCLUDED.data`,
      [packageName, ids, dates, payloads],
    );
    inserted += rowCount ?? 0;
  }

  return inserted;
}

/**
 * Of the given ids, which are not stored yet. The incremental sync uses this per page: once a page
 * returns nothing new, everything older is already held and the walk can stop.
 */
export async function findUnknownIds(packageName: string, ids: string[]): Promise<Set<string>> {
  if (!isStoreEnabled() || ids.length === 0) return new Set(ids);

  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM reviews WHERE package_name = $1 AND id = ANY($2::text[])`,
    [packageName, ids],
  );

  const known = new Set(rows.map((row) => row.id));
  return new Set(ids.filter((id) => !known.has(id)));
}
