/**
 * scripts/seed-migration-journal.ts
 *
 * One-shot script: inserts rows into drizzle.__drizzle_migrations for all
 * existing migrations so that `npm run db:migrate` stops replaying them.
 *
 * Background: the DB was originally bootstrapped with `drizzle-kit push`,
 * which applies the schema but doesn't write to the migration journal.
 * Every subsequent `db:migrate` tried to replay all SQL files from scratch,
 * producing NOTICE spam and a hard error on non-idempotent ALTER statements.
 *
 * Safe to run multiple times — it skips entries whose hash already exists.
 *
 * Usage:
 *   npx tsx scripts/seed-migration-journal.ts
 */

import 'dotenv/config';
import postgres from 'postgres';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set.');
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  // Read the journal to get the same entries Drizzle's migrator would read
  const journalPath = path.join(process.cwd(), 'drizzle', 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));

  // Ensure the drizzle schema + migrations table exist (same DDL the migrator uses)
  await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
  await sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )
  `;

  // Fetch existing hashes so we can skip duplicates
  const existing = await sql`SELECT hash FROM "drizzle"."__drizzle_migrations"`;
  const existingHashes = new Set(existing.map((r) => r.hash as string));

  let inserted = 0;
  for (const entry of journal.entries) {
    const filePath = path.join(process.cwd(), 'drizzle', `${entry.tag}.sql`);
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    if (existingHashes.has(hash)) {
      console.log(`[skip] ${entry.tag} — already in journal`);
      continue;
    }

    await sql`
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES (${hash}, ${entry.when})
    `;
    console.log(`[seed] ${entry.tag} → ${hash.slice(0, 12)}…`);
    inserted++;
  }

  console.log(`Done. Inserted ${inserted} row(s), skipped ${journal.entries.length - inserted}.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
