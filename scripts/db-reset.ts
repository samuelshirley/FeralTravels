/**
 * Nuclear DB reset: drops ALL tables (including Drizzle's migration journal)
 * then pushes the current schema fresh via drizzle-kit push.
 *
 * Usage: npx tsx scripts/db-reset.ts
 *
 * Only use this when you're okay losing all data.
 *
 * ── It refuses the production database ────────────────────────────────────
 *
 * `.env` on the owner's machine points at production, so the bare command above
 * used to drop every production table with no question asked. Since 2026-09-21
 * it refuses when DATABASE_URL is the production Neon endpoint (or
 * VERCEL_ENV=production), and prints the row counts it would have destroyed
 * plus a one-time challenge. The only way past is
 *
 *   npx tsx scripts/db-reset.ts --i-understand-this-wipes-production=<endpoint-id>:<challenge>
 *
 * with the endpoint id typed from .env (it is not printed and not in the repo)
 * and the challenge from the refusal. The challenge covers today's UTC date and
 * the database's current contents, so it is single-use: once the wipe it
 * authorised has run, it no longer matches. See src/server/productionGuard.ts.
 * Decision E13.
 */
import 'dotenv/config';
import postgres from 'postgres';
import {
  isProductionDatabaseUrl,
  WIPE_OVERRIDE_FLAG,
  wipeChallenge,
  wipeOverrideFrom,
  wipeOverrideValid,
  neonEndpointId,
} from '../src/server/productionGuard';

type Sql = ReturnType<typeof postgres>;

/**
 * What is in the database right now: its tables, and every `users` row id.
 * The wipe challenge is bound to this, so the challenge dies with the data.
 */
async function fingerprint(sql: Sql): Promise<string> {
  const tables = await sql<{ t: string }[]>`
    SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  const names = tables.map((r) => r.t);
  let users = 'no-users-table';
  if (names.includes('users')) {
    const [row] = await sql<{ n: string; h: string | null }[]>`
      SELECT count(*)::text AS n, md5(string_agg(id, ',' ORDER BY id)) AS h FROM users`;
    users = `${row.n}:${row.h ?? ''}`;
  }
  return `${names.join(',')}|${users}`;
}

/** Row counts for the tables worth naming before anything is destroyed. */
async function describe(sql: Sql): Promise<string[]> {
  const out: string[] = [];
  for (const t of ['users', 'trips', 'subscriptions', 'subscription_events', 'chat_history']) {
    try {
      const [row] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${sql(t)}`;
      out.push(`  ${t.padEnd(20)} ${row.n}`);
    } catch {
      out.push(`  ${t.padEnd(20)} (no table)`);
    }
  }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }
  if (process.env.VERCEL_ENV === 'production') {
    // No override here: a deployed production process has no business running
    // this at all. The override exists for a human at a terminal.
    throw new Error('db-reset refuses to run with VERCEL_ENV=production.');
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  if (isProductionDatabaseUrl(process.env.DATABASE_URL)) {
    const utcDate = new Date().toISOString().slice(0, 10);
    const fp = await fingerprint(sql);
    const override = wipeOverrideFrom(process.argv.slice(2));

    if (!wipeOverrideValid(override, process.env.DATABASE_URL, utcDate, fp)) {
      const endpoint = neonEndpointId(process.env.DATABASE_URL) ?? '';
      console.error('REFUSED: DATABASE_URL is the PRODUCTION database.');
      console.error('');
      console.error('It holds:');
      for (const line of await describe(sql)) console.error(line);
      console.error('');
      if (override) console.error('The override given does not match (wrong endpoint, stale, or reused).');
      console.error('To drop every table in it anyway, run again with:');
      console.error(`  ${WIPE_OVERRIDE_FLAG}=<production endpoint id>:${wipeChallenge(endpoint, utcDate, fp)}`);
      console.error('The endpoint id is the `ep-…` host label in DATABASE_URL (without -pooler).');
      console.error('This challenge is valid today (UTC) and only for the data listed above.');
      await sql.end();
      process.exit(2);
    }
    console.log('Production override accepted. Wiping production.');
  }

  console.log('Dropping all tables in public schema...');

  // Drop everything in public schema — CASCADE handles FK ordering
  await sql.unsafe(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      -- Drop all tables
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
      -- Drop all sequences
      FOR r IN (SELECT sequencename FROM pg_sequences WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP SEQUENCE IF EXISTS public.' || quote_ident(r.sequencename) || ' CASCADE';
      END LOOP;
    END $$;
  `);

  // Also drop Drizzle's migration tracking schema so it starts fresh
  await sql.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE;`);

  console.log('Done. All tables dropped.');
  console.log('Now run: npx drizzle-kit push');

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
