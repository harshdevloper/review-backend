import { Pool } from 'pg';
import { env } from '../config/env.js';

let pool: Pool | null = null;

/**
 * The database is optional: without DATABASE_URL the app still runs, it just re-scrapes every
 * time and keeps results in the in-memory cache (the pre-database behaviour).
 */
export function isStoreEnabled(): boolean {
  return Boolean(env.databaseUrl);
}

export function getPool(): Pool {
  if (!env.databaseUrl) {
    throw new Error('getPool() called without DATABASE_URL — guard with isStoreEnabled() first.');
  }
  if (!pool) {
    const isLocal = /@(localhost|127\.0\.0\.1)/.test(env.databaseUrl);
    pool = new Pool({
      connectionString: env.databaseUrl,
      // Neon and Supabase terminate TLS with certificates that aren't in Node's default trust
      // store; local Postgres normally has no TLS at all
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (error) => {
      console.error('[db] idle client error:', error.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
