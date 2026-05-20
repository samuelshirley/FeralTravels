/**
 * Nuclear DB reset: drops ALL tables (including Drizzle's migration journal)
 * then pushes the current schema fresh via drizzle-kit push.
 *
 * Usage: npx tsx scripts/db-reset.ts
 *
 * Only use this when you're okay losing all data.
 */
import 'dotenv/config';
import postgres from 'postgres';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

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
