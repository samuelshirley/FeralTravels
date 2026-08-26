/**
 * Read-only: what has this app actually cost, per user and per trip?
 *
 * Run with `npx tsx scripts/lifetime-spend.ts` (DATABASE_URL from .env).
 * Safe against production — it only SELECTs.
 *
 * Written to answer one question: what should the per-user usage cap be?
 * Guessing a number and calling it "50% of the subscription" sounds
 * principled but isn't, because it isn't anchored to what a user actually
 * costs. This prints the real distribution so the threshold can be picked
 * from data instead of vibes.
 *
 * WHY ANTHROPIC AND GOOGLE ARE REPORTED SEPARATELY, and why only one of
 * them should drive a cap: `logGooglePlacesUsage` stores the GROSS estimate
 * (per-call list price × calls). Google's free tier resets monthly across
 * every row, so it can only be subtracted at aggregate time — see
 * GoogleBillableSummary in src/server/repos/usage.ts. Most Google spend in
 * this table is therefore money nobody was ever billed for. Anthropic rows
 * are real money from the first token, so Anthropic is the number a cap
 * should watch.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';

/** cost_microcents → dollars. 1¢ = 1_000_000 microcents, so $1 = 1e8. */
function usd(microcents: number | string | null | undefined, dp = 2): string {
  return `$${((Number(microcents) || 0) / 1e8).toFixed(dp)}`;
}

function pad(v: string | number, n: number) {
  const s = String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env before running.');
  }
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  const [totals] = await db.execute<{
    anthropic: string; google: string; events: string;
    llm_calls: string; first_event: string | null;
  }>(sql`
    SELECT
      COALESCE(SUM(cost_microcents) FILTER (WHERE provider LIKE 'anthropic%'), 0) AS anthropic,
      COALESCE(SUM(cost_microcents) FILTER (WHERE provider LIKE 'google%'), 0)    AS google,
      COUNT(*)                                                                    AS events,
      COUNT(*) FILTER (WHERE provider LIKE 'anthropic%')                           AS llm_calls,
      MIN(created_at)::text                                                        AS first_event
    FROM usage_events
  `);

  const [tripTotals] = await db.execute<{ trips: string; users: string }>(sql`
    SELECT (SELECT COUNT(*) FROM trips)::text AS trips,
           (SELECT COUNT(*) FROM users)::text AS users
  `);

  const anthropicTotal = Number(totals.anthropic);
  const tripCount = Number(tripTotals.trips);

  console.log('\n=== LIFETIME ===');
  console.log(`  since            ${totals.first_event ?? 'n/a'}`);
  console.log(`  users            ${tripTotals.users}`);
  console.log(`  trips            ${tripTotals.trips}`);
  console.log(`  Anthropic        ${usd(anthropicTotal)}   <- real money`);
  console.log(`  Google (gross)   ${usd(totals.google)}   <- mostly inside the monthly free tier`);
  console.log(`  LLM calls        ${totals.llm_calls} of ${totals.events} events`);
  if (tripCount > 0) {
    console.log(`\n  Anthropic per trip   ${usd(anthropicTotal / tripCount, 4)}`);
  }

  const rows = await db.execute<{
    email: string | null; trips: string; anthropic: string; google: string; llm_calls: string;
  }>(sql`
    SELECT u.email,
           COALESCE(t.trips, 0)::text                                                  AS trips,
           COALESCE(SUM(e.cost_microcents) FILTER (WHERE e.provider LIKE 'anthropic%'), 0) AS anthropic,
           COALESCE(SUM(e.cost_microcents) FILTER (WHERE e.provider LIKE 'google%'), 0)    AS google,
           COUNT(e.id) FILTER (WHERE e.provider LIKE 'anthropic%')                     AS llm_calls
    FROM users u
    LEFT JOIN usage_events e ON e.user_id = u.id
    LEFT JOIN (SELECT user_id, COUNT(*) AS trips FROM trips GROUP BY user_id) t ON t.user_id = u.id
    GROUP BY u.email, t.trips
    ORDER BY 3 DESC
  `);

  console.log('\n=== PER USER (by Anthropic spend) ===');
  console.log(`  ${pad('email', 34)} ${pad('trips', 7)} ${pad('anthropic', 11)} ${pad('google(gr)', 11)} ${pad('$/trip', 10)} calls`);
  for (const r of rows) {
    const a = Number(r.anthropic);
    const tr = Number(r.trips);
    console.log(
      `  ${pad(r.email ?? '(deleted)', 34)} ${pad(r.trips, 7)} ${pad(usd(a), 11)} ${pad(usd(r.google), 11)} ${pad(tr ? usd(a / tr, 4) : '—', 10)} ${r.llm_calls}`
    );
  }

  // What a cap would actually do, checked against every real user rather
  // than assumed. A threshold no existing user approaches is a backstop; a
  // threshold several users cross is a pricing decision in disguise.
  console.log('\n=== WHAT A CAP WOULD HAVE CAUGHT (lifetime, all users) ===');
  for (const cap of [1, 2, 5, 10]) {
    const hit = rows.filter((r) => Number(r.anthropic) / 1e8 >= cap).length;
    console.log(`  $${cap}/yr cap  ->  ${hit} of ${rows.length} users would be blocked`);
  }
  console.log('');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
