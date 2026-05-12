/**
 * Recompute users.needs_vehicle_profile_remediation for every user row.
 * Safe to run multiple times — uses the same predicate as SSR + API snapshots.
 *
 * Usage: `npx tsx scripts/remediation-backfill-flags.ts`
 *
 * Requires DATABASE_URL (.env via dotenv/config).
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { users } from '@/server/db/schema';
import { recalculateUserRemediationFlag } from '@/server/repos/remediationFlags';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .orderBy(sql`${users.id} asc`);

    let n = 0;
    for (const row of rows) {
      await recalculateUserRemediationFlag(row.id);
      n += 1;
      if (n % 200 === 0) process.stdout.write(`… ${n} users\r`);
    }
    console.log(`Updated remediation flags for ${n} users.`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
