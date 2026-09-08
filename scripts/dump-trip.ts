/**
 * Read-only: dump one trip's rows so a bug report can be checked against the
 * database instead of a screenshot.
 *
 * Run with:
 *   npx tsx scripts/dump-trip.ts "National Park Tour"
 *   npx tsx scripts/dump-trip.ts <trip-uuid> --json
 *
 * DATABASE_URL comes from .env — which points at PRODUCTION. Safe against it:
 * every statement is a SELECT, and there is no write path in this file.
 *
 * Matching by NAME is a prefix/substring match, case-insensitive, newest
 * first; if it matches more than one trip the script prints the candidates and
 * stops rather than guessing which one you meant.
 *
 * WHY NOT src/server/db/client.ts: it is `server-only` and throws under tsx.
 * Same postgres-js + drizzle shape as scripts/lifetime-spend.ts.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pad(v: unknown, n: number) {
  const s = v === null || v === undefined ? '—' : String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

/** Collapse a chat body to one line so the transcript reads as a table. */
function oneLine(s: string, n: number) {
  return pad(s.replace(/\s+/g, ' ').trim(), n);
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const needle = args.filter((a) => !a.startsWith('--')).join(' ').trim();

  if (!needle) {
    throw new Error(
      'Usage: npx tsx scripts/dump-trip.ts "<trip name or uuid>" [--json]'
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it to .env before running.');
  }

  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(client);

  try {
    const candidates = await db.execute<{
      id: string; name: string; user_id: string; email: string | null;
      created_at: string;
    }>(
      UUID_RE.test(needle)
        ? sql`SELECT t.id, t.name, t.user_id, u.email, t.created_at::text
                FROM trips t LEFT JOIN users u ON u.id = t.user_id
               WHERE t.id = ${needle}::uuid`
        : sql`SELECT t.id, t.name, t.user_id, u.email, t.created_at::text
                FROM trips t LEFT JOIN users u ON u.id = t.user_id
               WHERE t.name ILIKE ${'%' + needle + '%'}
               ORDER BY t.created_at DESC LIMIT 10`
    );

    if (candidates.length === 0) {
      console.log(`No trip matching ${JSON.stringify(needle)}.`);
      return;
    }
    if (candidates.length > 1) {
      console.log(`${candidates.length} trips match ${JSON.stringify(needle)} — re-run with the id:\n`);
      for (const c of candidates) {
        console.log(`  ${c.id}  ${pad(c.name, 32)}  ${pad(c.email, 34)}  ${c.created_at}`);
      }
      return;
    }

    const trip = candidates[0];

    const [row] = await db.execute<Record<string, unknown>>(sql`
      SELECT * FROM trips WHERE id = ${trip.id}::uuid
    `);

    const legs = await db.execute<{
      id: string; sort_order: number; leg_type: string; title: string | null;
      start_name: string | null; end_name: string | null; dates: string | null;
      distance_km: string | null; drive_time_minutes: number | null;
      fuel_status: string | null; fuel_stops_updated_at: string | null;
      fuel_plan_error: string | null; stop_count: string;
    }>(sql`
      SELECT l.id, l.sort_order, l.leg_type, l.title, l.start_name, l.end_name,
             l.dates, l.distance_km, l.drive_time_minutes, l.fuel_status,
             l.fuel_stops_updated_at::text, l.fuel_plan_error,
             (SELECT COUNT(*) FROM stops s WHERE s.leg_id = l.id)::text AS stop_count
        FROM legs l WHERE l.trip_id = ${trip.id}::uuid
       ORDER BY l.sort_order ASC
    `);

    const chat = await db.execute<{
      seq: number; role: string; kind: string; content: string;
      changes_made: string | null; has_plan_summary: boolean; created_at: string;
    }>(sql`
      SELECT seq, role, kind, content, changes_made,
             (plan_summary IS NOT NULL) AS has_plan_summary,
             created_at::text
        FROM chat_history WHERE trip_id = ${trip.id}::uuid
       ORDER BY seq ASC
    `);

    const turns = await db.execute<{
      id: string; status: string; idempotency_key: string;
      user_message: string; error_message: string | null;
      created_at: string; updated_at: string | null;
    }>(sql`
      SELECT id, status, idempotency_key, user_message, error_message,
             created_at::text, updated_at::text
        FROM penny_turns WHERE trip_id = ${trip.id}::uuid
       ORDER BY created_at ASC
    `);

    const usage = await db.execute<{
      provider: string; success: boolean; n: string; cost: string;
      last_at: string; last_error: string | null;
    }>(sql`
      SELECT provider, success, COUNT(*)::text AS n,
             COALESCE(SUM(cost_microcents), 0)::text AS cost,
             MAX(created_at)::text AS last_at,
             (ARRAY_AGG(error_message ORDER BY created_at DESC)
                FILTER (WHERE error_message IS NOT NULL))[1] AS last_error
        FROM usage_events WHERE trip_id = ${trip.id}::uuid
       GROUP BY provider, success ORDER BY provider, success
    `);

    if (asJson) {
      console.log(JSON.stringify({ trip: row, legs, chat, turns, usage }, null, 2));
      return;
    }

    console.log(`\n=== TRIP ${trip.id} ===`);
    console.log(`name        ${trip.name}`);
    console.log(`owner       ${trip.email ?? trip.user_id}`);
    for (const k of [
      'created_at', 'start_date_parsed', 'daily_drive_hours', 'onboarding_state',
      'vehicle_id', 'current_leg_id', 'last_known_place', 'declared_range_km',
      'trip_status', 'status',
    ]) {
      if (k in row) console.log(`${pad(k, 12)}${String(row[k] ?? '—')}`);
    }
    const scan = row['onboarding_scan'];
    if (scan) console.log(`scan        ${JSON.stringify(scan)}`);

    console.log(`\n=== LEGS (${legs.length}) ===`);
    console.log(
      `${pad('#', 3)} ${pad('type', 6)} ${pad('date', 11)} ${pad('start', 22)} ${pad('end', 22)} ${pad('km', 7)} ${pad('min', 5)} ${pad('fuel', 18)} stops`
    );
    for (const l of legs) {
      console.log(
        `${pad(l.sort_order, 3)} ${pad(l.leg_type, 6)} ${pad(l.dates, 11)} ${pad(l.start_name, 22)} ${pad(l.end_name, 22)} ${pad(l.distance_km, 7)} ${pad(l.drive_time_minutes, 5)} ${pad(l.fuel_status, 18)} ${l.stop_count}`
      );
      if (l.fuel_plan_error) console.log(`      fuel error: ${l.fuel_plan_error}`);
    }

    console.log(`\n=== CHAT (${chat.length} rows) ===`);
    console.log(
      `${pad('seq', 5)} ${pad('created_at', 26)} ${pad('role', 9)} ${pad('kind', 14)} ${pad('applied', 7)} content`
    );
    for (const c of chat) {
      console.log(
        `${pad(c.seq, 5)} ${pad(c.created_at, 26)} ${pad(c.role, 9)} ${pad(c.kind, 14)} ${pad(c.changes_made ? 'yes' : (c.has_plan_summary ? 'summary' : ''), 7)} ${oneLine(c.content, 110)}`
      );
    }

    console.log(`\n=== PENNY TURNS (${turns.length}) ===`);
    for (const t of turns) {
      console.log(
        `${pad(t.status, 8)} created ${pad(t.created_at, 26)} updated ${pad(t.updated_at, 26)}`
      );
      console.log(`         key ${t.idempotency_key}  msg: ${oneLine(t.user_message, 80)}`);
      if (t.error_message) console.log(`         error: ${t.error_message}`);
    }

    console.log(`\n=== USAGE ===`);
    for (const u of usage) {
      console.log(
        `${pad(u.provider, 28)} ${u.success ? 'ok  ' : 'FAIL'} ${pad(u.n, 5)} $${(Number(u.cost) / 1e8).toFixed(4)}  last ${u.last_at}${u.last_error ? `  — ${oneLine(u.last_error, 80)}` : ''}`
      );
    }
    console.log('');
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
