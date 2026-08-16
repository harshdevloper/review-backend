import { getPool, isStoreEnabled } from './pool.js';

// Reviews are stored as JSONB rather than exploded into columns: the shape is dictated by the
// scraper and changes with it, and every read wants the whole object anyway. posted_at is lifted
// out because it is the only field the queries sort or filter on.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  package_name       TEXT PRIMARY KEY,
  details            JSONB       NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_country     TEXT,
  reviews_complete   BOOLEAN     NOT NULL DEFAULT false,
  review_stop_reason TEXT
);

ALTER TABLE apps ADD COLUMN IF NOT EXISTS review_country TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS reviews_complete BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS review_stop_reason TEXT;

CREATE TABLE IF NOT EXISTS reviews (
  package_name TEXT        NOT NULL REFERENCES apps(package_name) ON DELETE CASCADE,
  id           TEXT        NOT NULL,
  posted_at    TIMESTAMPTZ,
  data         JSONB       NOT NULL,
  PRIMARY KEY (package_name, id)
);

CREATE INDEX IF NOT EXISTS reviews_by_recency ON reviews (package_name, posted_at DESC NULLS LAST);
`;

export async function ensureSchema(): Promise<void> {
  if (!isStoreEnabled()) {
    console.log('[db] DATABASE_URL not set — running without persistence (every fetch re-scrapes)');
    return;
  }
  await getPool().query(SCHEMA);
  console.log('[db] schema ready');
}
