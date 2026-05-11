/**
 * Thin Drizzle handle for use inside tests + the seed/cleanup scripts.
 *
 * Why a separate file from src/server/db/client.ts:
 *   - The app's client.ts uses `import 'server-only'` which throws when
 *     evaluated outside a Next.js server bundle (which is what tsx +
 *     Playwright are). Inlining the connection here avoids that guard.
 *   - We open ONE connection per process; the seed/cleanup scripts are
 *     short-lived so a single client is plenty.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../src/server/db/schema';

let _db: ReturnType<typeof drizzle> | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('[e2e/db] DATABASE_URL is not set.');
  _sql = postgres(url, { max: 1 });
  _db = drizzle(_sql, { schema });
  return _db;
}

export async function closeDb() {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
  }
}

export { schema };
