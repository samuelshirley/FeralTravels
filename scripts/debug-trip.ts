/**
 * Read-only diagnosis for a trip's recent Penny activity (DATABASE_URL required).
 *
 * Prints, for each recent assistant turn:
 *   - The user's prompt
 *   - Penny's text response
 *   - changes_made — the structured list of actions she actually applied this turn
 *     (this is what tells us whether `planFuelStops` ran, or whether she lied)
 *   - The matching anthropic:replan usage_events row: tokens (input/output/
 *     cache_creation/cache_read), cost in cents, success flag
 *
 * Usage:
 *   # If you have the trip UUID:
 *   npx tsx scripts/debug-trip.ts <tripId>
 *
 *   # Or look up by trip name (uses the most recent trip matching the name):
 *   npx tsx scripts/debug-trip.ts --name "Summer '26 Trip"
 *
 *   # Or just grab the most recent trip across the whole DB:
 *   npx tsx scripts/debug-trip.ts --latest
 *
 * Limits: shows the last 10 chat turns + last 20 usage events on the trip.
 * Read-only — no writes.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { chatHistory, legs, stops, trips, usageEvents } from '@/server/db/schema';

type Args =
  | { mode: 'id'; tripId: string }
  | { mode: 'name'; name: string }
  | { mode: 'latest' };

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/debug-trip.ts <tripId | --name "Trip Name" | --latest>');
    process.exit(1);
  }
  if (args[0] === '--latest') return { mode: 'latest' };
  if (args[0] === '--name') {
    const name = args.slice(1).join(' ').trim();
    if (!name) {
      console.error('--name requires a value');
      process.exit(1);
    }
    return { mode: 'name', name };
  }
  return { mode: 'id', tripId: args[0] };
}

// Stored as microcents: 1¢ = 1,000,000 microcents, so $1 = 100,000,000 microcents.
function microcentsToUSD(microcents: number | null): string {
  if (microcents == null) return '$0.0000';
  return `$${(microcents / 100_000_000).toFixed(6)}`;
}

function fmtTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

async function main() {
  const args = parseArgs(process.argv);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client);

  try {
    // 1. Resolve trip
    let trip: { id: string; name: string; createdAt: Date } | null = null;
    if (args.mode === 'id') {
      const rows = await db
        .select({ id: trips.id, name: trips.name, createdAt: trips.createdAt })
        .from(trips)
        .where(eq(trips.id, args.tripId))
        .limit(1);
      trip = rows[0] ?? null;
    } else if (args.mode === 'name') {
      const rows = await db
        .select({ id: trips.id, name: trips.name, createdAt: trips.createdAt })
        .from(trips)
        .where(ilike(trips.name, `%${args.name}%`))
        .orderBy(desc(trips.createdAt))
        .limit(1);
      trip = rows[0] ?? null;
    } else {
      const rows = await db
        .select({ id: trips.id, name: trips.name, createdAt: trips.createdAt })
        .from(trips)
        .orderBy(desc(trips.createdAt))
        .limit(1);
      trip = rows[0] ?? null;
    }

    if (!trip) {
      console.error('No matching trip found.');
      process.exit(1);
    }

    console.log('='.repeat(80));
    console.log(`TRIP  ${trip.name}`);
    console.log(`  id  ${trip.id}`);
    console.log(`  created  ${fmtTime(trip.createdAt)}`);
    console.log('='.repeat(80));

    // 2. Recent chat turns, oldest-first (so the conversation reads top→bottom)
    const chats = await db
      .select()
      .from(chatHistory)
      .where(eq(chatHistory.tripId, trip.id))
      .orderBy(desc(chatHistory.seq))
      .limit(30);
    chats.reverse();

    console.log('\nCHAT — last %d turns (oldest-first):\n', chats.length);
    for (const row of chats) {
      const ts = fmtTime(row.createdAt);
      const role = row.role.padEnd(9);
      const kind = `[${row.kind}]`.padEnd(15);
      console.log(`--- ${ts}  ${role} ${kind} seq=${row.seq}`);
      console.log(trunc(row.content, 600));
      if (row.changesMade) {
        try {
          const parsed = JSON.parse(row.changesMade);
          const changes: unknown[] = Array.isArray(parsed?.changes) ? parsed.changes : [];
          console.log(`  → changes_made (${changes.length} action${changes.length === 1 ? '' : 's'}):`);
          for (const c of changes) {
            console.log('     ' + JSON.stringify(c));
          }
        } catch {
          console.log('  → changes_made (unparseable): ' + trunc(row.changesMade, 200));
        }
      } else if (row.role === 'assistant') {
        console.log('  → changes_made: null  (NO ACTIONS APPLIED THIS TURN)');
      }
      console.log();
    }

    // 3. Recent usage events for this trip — bump high enough to see the
    // initial plan-build anthropic row, which is usually the most expensive.
    const events = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.tripId, trip.id))
      .orderBy(desc(usageEvents.createdAt))
      .limit(100);
    events.reverse();

    // NOTE: usage_events.input_tokens currently *includes* cache_creation +
    // cache_read tokens summed in (src/server/repos/usage.ts:47-58). We can't
    // split them apart from the data. The dollar cost is still accurate.
    console.log('USAGE_EVENTS — last %d (oldest-first):\n', events.length);
    if (events.length === 0) {
      console.log('  (none)');
    } else {
      console.log(
        '  time                 provider                        in_total  out    cost          ok  err'
      );
      console.log('  ' + '-'.repeat(105));
      for (const e of events) {
        const time = fmtTime(e.createdAt);
        const provider = (e.provider || '').padEnd(32);
        const inT = String(e.inputTokens ?? '').padStart(8);
        const outT = String(e.outputTokens ?? '').padStart(5);
        const cost = microcentsToUSD(e.costMicrocents).padStart(12);
        const ok = e.success ? 'Y' : 'N';
        const err = e.errorMessage ? trunc(e.errorMessage, 30) : '';
        console.log(`  ${time}  ${provider}${inT}  ${outT}  ${cost}  ${ok}   ${err}`);
      }

      // Totals (input includes cache tokens summed in — see note above)
      let inT = 0, outT = 0, mc = 0;
      for (const e of events) {
        inT += e.inputTokens ?? 0;
        outT += e.outputTokens ?? 0;
        mc += e.costMicrocents ?? 0;
      }
      console.log('  ' + '-'.repeat(105));
      console.log(
        `  TOTALS (window)                                       ${String(inT).padStart(8)}  ${String(outT).padStart(5)}  ${microcentsToUSD(mc).padStart(12)}`
      );
      console.log('  (input column includes cache tokens — cache hit rate not currently recoverable from schema)');
    }

    // 4. Per-provider breakdown across ALL events on this trip (not just the
    // window above). Tells us total spend by source and request counts.
    const breakdown = await db
      .select({
        provider: usageEvents.provider,
        n: sql<number>`COUNT(*)::int`,
        cost: sql<number>`COALESCE(SUM(${usageEvents.costMicrocents}), 0)::bigint`,
        input: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)::int`,
        output: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)::int`,
      })
      .from(usageEvents)
      .where(eq(usageEvents.tripId, trip.id))
      .groupBy(usageEvents.provider)
      .orderBy(desc(sql<number>`SUM(${usageEvents.costMicrocents})`));

    console.log('\nTRIP-WIDE BREAKDOWN by provider:\n');
    console.log('  provider                              n      in_total   output     cost');
    console.log('  ' + '-'.repeat(82));
    let grandTotal = 0;
    for (const r of breakdown) {
      const provider = (r.provider || '').padEnd(34);
      const n = String(r.n).padStart(5);
      const inp = String(r.input).padStart(9);
      const out = String(r.output).padStart(7);
      const cost = microcentsToUSD(Number(r.cost)).padStart(11);
      console.log(`  ${provider}  ${n}   ${inp}  ${out}   ${cost}`);
      grandTotal += Number(r.cost);
    }
    console.log('  ' + '-'.repeat(82));
    console.log(`  GRAND TOTAL on this trip:${' '.repeat(46)}${microcentsToUSD(grandTotal).padStart(11)}`);

    // 5. Stops table for this trip's legs — helps diagnose "Penny said she
    // planned fuel stops but the UI shows none."
    const legRows = await db
      .select({ id: legs.id, sortOrder: legs.sortOrder, title: legs.title })
      .from(legs)
      .where(eq(legs.tripId, trip.id))
      .orderBy(legs.sortOrder);
    const stopRows = await db
      .select({
        id: stops.id,
        legId: stops.legId,
        stopType: stops.stopType,
        status: stops.status,
        name: stops.name,
        sortOrder: stops.sortOrder,
        distanceFromStartKm: stops.distanceFromStartKm,
        source: stops.source,
      })
      .from(stops)
      .innerJoin(legs, eq(stops.legId, legs.id))
      .where(eq(legs.tripId, trip.id))
      .orderBy(legs.sortOrder, stops.sortOrder);

    console.log(`\nSTOPS — ${stopRows.length} total across ${legRows.length} legs:\n`);
    if (stopRows.length === 0) {
      console.log('  (no stops — fuel stops have NOT been written to the DB for any leg)');
    } else {
      const byLeg = new Map<string, typeof stopRows>();
      for (const s of stopRows) {
        const existing = byLeg.get(s.legId) ?? [];
        existing.push(s);
        byLeg.set(s.legId, existing);
      }
      for (const leg of legRows) {
        const ls = byLeg.get(leg.id) ?? [];
        if (ls.length === 0) continue;
        console.log(`  Leg ${leg.sortOrder} (${leg.id.slice(0, 8)}…) ${leg.title}`);
        for (const s of ls) {
          const dist = s.distanceFromStartKm != null ? `${s.distanceFromStartKm.toFixed(1)} km` : '—';
          console.log(`    [${s.stopType}/${s.status}] ${s.name}  ${dist}  src=${s.source ?? '—'}`);
        }
      }
    }

    // 6. Sanity check across the whole DB so we know if logging is working at all
    const [{ totalEvents }] = await db
      .select({ totalEvents: sql<number>`COUNT(*)::int` })
      .from(usageEvents)
      .where(and(eq(usageEvents.tripId, trip.id)));
    const [{ totalChats }] = await db
      .select({ totalChats: sql<number>`COUNT(*)::int` })
      .from(chatHistory)
      .where(eq(chatHistory.tripId, trip.id));
    console.log(`\nTotals on this trip: ${totalChats} chat rows, ${totalEvents} usage_event rows, ${legRows.length} legs, ${stopRows.length} stops.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
