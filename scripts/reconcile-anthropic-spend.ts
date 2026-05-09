/**
 * One-off diagnostic: reconcile usage_events against Anthropic Console.
 *
 * Run with `npx tsx scripts/reconcile-anthropic-spend.ts` (DATABASE_URL must
 * be set in .env). Compares last-7-day totals against what Anthropic's
 * cost dashboard shows. If they don't match within ~5%, there's a math or
 * data bug in usage logging — chase it before adding more dashboard UI.
 *
 * Cross-check method: paste the daily Anthropic numbers from your Console
 * (Console → Settings → Cost) into the right column of the daily table this
 * script prints. Anything more than ~5% off per day is a real discrepancy.
 *
 * The script is read-only. Safe to run against production.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, gte, eq, and, desc } from 'drizzle-orm';
import { usageEvents, users } from '@/server/db/schema';

function usd(microcents: number | null | undefined): string {
  if (!microcents) return '$0.0000';
  return `$${(microcents / 100 / 1_000_000).toFixed(4)}`;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env before running.');
  }
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  const now = Date.now();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since24h = new Date(now - 24 * 60 * 60 * 1000);

  // ─── Section 1: Totals by provider (last 7d) ──────────────────────────
  // Compare the 'anthropic' row's total $ here against Anthropic Console.
  // The 'google-places' row reflects our ESTIMATED cost; Google's $200/mo
  // free credit means real $ charged is usually $0 even if estimate > $0.
  console.log('\n═══ Last 7d totals by provider ═══');
  const byProvider7d = await db
    .select({
      provider: usageEvents.provider,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
      inputTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)`,
      successCount: sql<number>`COALESCE(SUM(CASE WHEN ${usageEvents.success} THEN 1 ELSE 0 END), 0)`,
      failureCount: sql<number>`COALESCE(SUM(CASE WHEN NOT ${usageEvents.success} THEN 1 ELSE 0 END), 0)`,
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since7d))
    .groupBy(usageEvents.provider);

  console.table(
    byProvider7d.map((r) => ({
      provider: r.provider,
      usd: usd(r.microcents),
      requests: r.requests,
      input_tok: r.inputTokens,
      output_tok: r.outputTokens,
      ok: r.successCount,
      err: r.failureCount,
    }))
  );

  const anthropic7d = byProvider7d.find((r) => r.provider === 'anthropic');
  const projectedMonthly =
    anthropic7d != null ? (anthropic7d.microcents * 30) / 7 : 0;
  console.log(
    `Anthropic 7d total: ${usd(anthropic7d?.microcents)}    ` +
      `Projected monthly (×30/7): ${usd(projectedMonthly)}`
  );
  console.log(
    'If your admin dashboard shows the projected number as "AI spend (7d)",',
    "that's the labeling bug — the actual 7d spend is the first number."
  );

  // ─── Section 2: Daily Anthropic spend (last 7d) ───────────────────────
  // Compare each row directly against the Daily token cost bar chart in
  // Anthropic Console. Per-day variance > ~5% suggests a math bug.
  console.log('\n═══ Daily Anthropic spend (last 7d) ═══');
  const dailyAnthropic = await db
    .select({
      day: sql<string>`DATE(${usageEvents.createdAt})`,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
      inputTokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(gte(usageEvents.createdAt, since7d), eq(usageEvents.provider, 'anthropic'))
    )
    .groupBy(sql`DATE(${usageEvents.createdAt})`)
    .orderBy(sql`DATE(${usageEvents.createdAt})`);

  console.table(
    dailyAnthropic.map((r) => ({
      day: r.day,
      our_estimate: usd(r.microcents),
      requests: r.requests,
      input_tok: r.inputTokens,
      output_tok: r.outputTokens,
      console_reports: '(fill in from Anthropic dashboard)',
    }))
  );

  // ─── Section 3: Failed-vs-successful spend (last 7d) ──────────────────
  // Failed Anthropic requests still log usage at the totals captured before
  // the throw. Real surprise spend can hide here if retries spike.
  console.log('\n═══ Anthropic success vs failure split (last 7d) ═══');
  const successSplit = await db
    .select({
      success: usageEvents.success,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(gte(usageEvents.createdAt, since7d), eq(usageEvents.provider, 'anthropic'))
    )
    .groupBy(usageEvents.success);
  console.table(
    successSplit.map((r) => ({
      outcome: r.success ? 'success' : 'failure',
      usd: usd(r.microcents),
      rows: r.requests,
    }))
  );

  // ─── Section 4: Top users by all-time Anthropic spend ─────────────────
  // What you actually wanted: who's costing you the most, total. Joined
  // against the users table for emails. NULL emails are pre-auth events.
  console.log('\n═══ Top 20 users by ALL-TIME Anthropic spend ═══');
  const topUsersAllTime = await db
    .select({
      userId: usageEvents.userId,
      email: users.email,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
    })
    .from(usageEvents)
    .leftJoin(users, eq(users.id, usageEvents.userId))
    .where(eq(usageEvents.provider, 'anthropic'))
    .groupBy(usageEvents.userId, users.email)
    .orderBy(desc(sql`SUM(${usageEvents.costMicrocents})`))
    .limit(20);
  console.table(
    topUsersAllTime.map((r) => ({
      email: r.email ?? '(no user)',
      total_usd: usd(r.microcents),
      requests: r.requests,
    }))
  );

  // ─── Section 5: Last-24h activity per user ────────────────────────────
  // Who's actively burning credit RIGHT NOW.
  console.log('\n═══ Last 24h Anthropic activity per user ═══');
  const last24hUsers = await db
    .select({
      userId: usageEvents.userId,
      email: users.email,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
    })
    .from(usageEvents)
    .leftJoin(users, eq(users.id, usageEvents.userId))
    .where(
      and(gte(usageEvents.createdAt, since24h), eq(usageEvents.provider, 'anthropic'))
    )
    .groupBy(usageEvents.userId, users.email)
    .orderBy(desc(sql`SUM(${usageEvents.costMicrocents})`))
    .limit(20);
  console.table(
    last24hUsers.map((r) => ({
      email: r.email ?? '(no user)',
      usd_24h: usd(r.microcents),
      requests: r.requests,
    }))
  );

  // ─── Section 6: All-time totals — sanity check ────────────────────────
  // If this number is much bigger than your account-lifetime Anthropic
  // bill, something's logging twice somewhere.
  console.log('\n═══ All-time totals by provider (sanity check) ═══');
  const byProviderAllTime = await db
    .select({
      provider: usageEvents.provider,
      requests: sql<number>`COALESCE(SUM(${usageEvents.requests}), 0)`,
      microcents: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)`,
      rowCount: sql<number>`COUNT(*)`,
      firstSeen: sql<Date>`MIN(${usageEvents.createdAt})`,
    })
    .from(usageEvents)
    .groupBy(usageEvents.provider);
  console.table(
    byProviderAllTime.map((r) => ({
      provider: r.provider,
      total_usd: usd(r.microcents),
      requests: r.requests,
      rows: r.rowCount,
      since: r.firstSeen,
    }))
  );

  await client.end();

  // ─── Reconciliation guidance ──────────────────────────────────────────
  console.log('\n═══ How to read this ═══');
  console.log(
    [
      '1. Section 1 "anthropic" usd vs Anthropic Console "Month to date":',
      '   should match within ~5%. Console rounds and excludes mid-flight',
      '   requests. Bigger gap = math bug.',
      '',
      '2. Section 2 daily numbers vs Console "Daily token cost" bars:',
      '   per-day mismatch points at pricing constants (Sonnet 4 base $3/$15;',
      '   cache write 1.25x; cache read 0.10x).',
      '',
      '3. Section 3 failure rows: failed requests still cost money. If',
      '   failure usd > 10% of success usd, retry storms or auth errors',
      '   are leaking spend.',
      '',
      '4. Section 4 / 5: who you suspected was a heavy user vs reality.',
      '   If your own admin email is at the top, your dev usage is',
      '   skewing the dashboard — filter it out before drawing conclusions.',
      '',
      '5. Section 6 "google-places" total > $0: that is our ESTIMATED',
      "   cost. Google's $200/mo free credit usually zeros it out at",
      '   the actual bill. Compare against your Google Cloud Billing',
      '   page; do not treat the estimate as money out the door.',
    ].join('\n')
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
