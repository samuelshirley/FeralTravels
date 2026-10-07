import { inject } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '@/server/db/schema';

/**
 * A real, in-process Postgres (PGlite) carrying the real schema, for the repo
 * round-trip tests in this folder. No service, no network, no DATABASE_URL:
 * nothing here can reach a deployed database.
 *
 * A test file swaps the app's client for this one:
 *
 *   vi.mock('server-only', () => ({}));
 *   vi.mock('@/server/db/client', async () => (await import('./harness')).clientModule());
 *
 * and the REAL repo functions then run against Postgres semantics — jsonb,
 * `date`, enums, generated columns, unique indexes, FK cascades. One database
 * per test file; `resetDb()` truncates between tests.
 */

function makeDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema, logger: false });
  return { client, db };
}

let instance: Promise<ReturnType<typeof makeDb>> | null = null;

export function testDb() {
  instance ??= (async () => {
    const made = makeDb();
    for (const statement of inject('pgSchemaDdl')) await made.client.exec(statement);
    return made;
  })();
  return instance;
}

/** The shape of `@/server/db/client`, backed by PGlite. */
export async function clientModule() {
  const { db } = await testDb();
  return { db, schema };
}

/** Empties every table. Cheap enough to run before each test. */
export async function resetDb() {
  const { db, client } = await testDb();
  const { rows } = await client.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  await db.execute(
    sql.raw(`truncate ${rows.map((r) => `"${r.tablename}"`).join(', ')} restart identity cascade`),
  );
}

/** Raw SQL, for reading back what the repo actually stored. */
export async function rawQuery<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const { client } = await testDb();
  return (await client.query<T>(text, params)).rows;
}

/**
 * A user row. Users are created by Auth.js's adapter on first sign-in, which no
 * repo wraps, so the tests insert the row the adapter would.
 */
export async function seedUser(email = `user-${crypto.randomUUID()}@pg.test`) {
  const { db } = await testDb();
  const [row] = await db.insert(schema.users).values({ email, name: 'PG Test' }).returning();
  return row;
}

/** The Postgres error behind a rejected drizzle query (drizzle may wrap it). */
export async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    return e.code ? e : (e.cause ?? {});
  }
  throw new Error('expected the query to be rejected');
}
