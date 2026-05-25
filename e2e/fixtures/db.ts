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

function makeSql(url: string) {
  // Mirror src/server/db/client.ts — Neon drops idle connections and
  // rejects prepared statements on pooled endpoints. The Penny E2E test
  // can sit idle for ~60s while Anthropic streams; the next query then
  // hits ECONNRESET unless we reconnect.
  return postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export function getDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('[e2e/db] DATABASE_URL is not set.');
  _sql = makeSql(url);
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

function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    err.message.includes('Connection terminated')
  );
}

/** Retry once after resetting the client — covers Neon idle disconnects mid-suite. */
export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    await closeDb();
    return await fn();
  }
}

export { schema };
