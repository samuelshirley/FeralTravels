/**
 * Empty a PR preview database after the migration rehearsal, before anything
 * deploys against it.
 *
 *   NEON_BRANCH=preview/pr-<N> PREVIEW_DB_WIPE_CONFIRM=preview/pr-<N> \
 *     DATABASE_URL=… npx tsx scripts/wipe-preview-db.ts
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * ci.yml's preview job creates `preview/pr-<N>` as a copy of PROD, so that
 * `npm run db:migrate` rehearses the migration against prod's real schema,
 * journal and rows. That rehearsal is kept. What is not kept is the rows
 * themselves: the branch then backs two public Vercel previews running
 * unreviewed code with the /api/test/* endpoints armed (Sam, 2026-09-30:
 * "do we put customer data on the preview DB? we probably shouldn't").
 * Nothing in the suites needs them — every spec and flow mints its own
 * fixture user — and fixture data is what the coverage job then measures.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *
 *  1. Refuses unless NEON_BRANCH and PREVIEW_DB_WIPE_CONFIRM are both set,
 *     equal, and name a PR preview branch (`previewWipeRefusal`). Before it
 *     connects to anything.
 *  2. Lists every base table in `public` AT RUNTIME, so a table added later is
 *     wiped by default, and TRUNCATEs all of them but `KEEP_TABLES` in one
 *     statement. Schema `drizzle` (the migrations journal) is never touched.
 *  3. Counts again and exits 1 if any wiped table has a row, or if a table in
 *     a schema it does not own (not public, not drizzle) holds rows — that is
 *     data it cannot vouch for, so the preview must not deploy.
 *
 * FAIL CLOSED: ci.yml runs this before the first `vercel deploy`, without
 * continue-on-error, so a failure here means no preview URL ever existed for
 * this database. `src/lib/previewWipeGuard.test.ts` holds that order.
 *
 * Prints table names and counts only: never the DATABASE_URL, never a row.
 */
import 'dotenv/config';
import postgres from 'postgres';
import {
  KEEP_TABLES,
  previewWipeRefusal,
  quoteIdent,
  tablesToWipe,
  truncateStatement,
  wipeLeftovers,
} from '../src/lib/columnCoverage';

/** Schemas that are Postgres's own, or the migrations journal, which must survive. */
const NOT_OURS_TO_CHECK = ['pg_catalog', 'information_schema', 'drizzle'];

async function main(): Promise<number> {
  const refusal = previewWipeRefusal({
    neonBranch: process.env.NEON_BRANCH,
    confirm: process.env.PREVIEW_DB_WIPE_CONFIRM,
  });
  if (refusal) {
    console.error(`wipe-preview-db: refusing — ${refusal}. This only runs in CI against preview/pr-<N>.`);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('wipe-preview-db: DATABASE_URL is not set.');
    return 1;
  }

  // TLS as every Neon script has it; a local throwaway cluster has none.
  const local = url.includes('localhost') || url.includes('127.0.0.1');
  const sql = postgres(url, { ssl: local ? false : 'require', max: 1, onnotice: () => {} });
  try {
    const tables = await sql<{ table_name: string; table_schema: string }[]>`
      select table_schema, table_name from information_schema.tables
      where table_type = 'BASE TABLE'
        and table_schema not in ${sql(NOT_OURS_TO_CHECK)}
        and table_schema not like 'pg\\_%'
    `;
    const publicTables = tables.filter((t) => t.table_schema === 'public').map((t) => t.table_name);
    const others = tables.filter((t) => t.table_schema !== 'public');
    const wipe = tablesToWipe(publicTables);
    if (wipe.length === 0) {
      console.error('wipe-preview-db: found no tables in public — wrong database?');
      return 1;
    }

    await sql.unsafe(truncateStatement(wipe));

    const count = async (schema: string, table: string) => {
      const [row] = await sql.unsafe<{ n: string }[]>(
        `select count(*)::text as n from ${quoteIdent(schema)}.${quoteIdent(table)}`,
      );
      return Number(row.n);
    };
    const publicCounts: Record<string, number> = {};
    for (const t of publicTables) publicCounts[t] = await count('public', t);
    const otherCounts: Record<string, number> = {};
    for (const t of others) otherCounts[`${t.table_schema}.${t.table_name}`] = await count(t.table_schema, t.table_name);

    const left = wipeLeftovers(publicCounts, otherCounts);
    if (left.length > 0) {
      console.error(`wipe-preview-db: NOT EMPTY after the wipe — the preview must not deploy:\n  ${left.join('\n  ')}`);
      return 1;
    }
    const kept = publicTables.filter((t) => t in KEEP_TABLES).sort();
    console.log(
      `wipe-preview-db: wiped ${wipe.length} tables on ${process.env.NEON_BRANCH}; users = ${publicCounts.users ?? 'no table'}; kept ${kept.join(', ') || 'none'}.`,
    );
    return 0;
  } catch (err) {
    console.error('wipe-preview-db: failed —', err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await sql.end();
  }
}

main().then((code) => process.exit(code));
