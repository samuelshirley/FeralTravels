/**
 * One-shot script: inserts the initial "DB wipe" announcement.
 * Idempotent — skips if an announcement with the same title already exists.
 *
 * Usage:  npx tsx scripts/seed-first-announcement.ts
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { announcements } from '../src/server/db/schema';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });
const db = drizzle(sql);

async function main() {
  const title = 'Lots of Yuge updates';
  const body =
    'I also had to wipe the DB sorry if you lost a trip you were working on - shouldn\'t happen again';
  const buttonText = 'Wow nice job Sam';

  // Check if it already exists
  const existing = await db
    .select({ id: announcements.id })
    .from(announcements)
    .where(eq(announcements.title, title))
    .limit(1);

  if (existing.length > 0) {
    console.log('Announcement already exists, skipping.');
  } else {
    const [row] = await db
      .insert(announcements)
      .values({ title, body, buttonText, active: true })
      .returning();
    console.log(`Created announcement: ${row.id}`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
