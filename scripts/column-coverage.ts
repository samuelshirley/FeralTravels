/**
 * Which tables and columns did the tests actually write?
 *
 *   DATABASE_URL=… npx tsx scripts/column-coverage.ts        # report only
 *   COVERAGE_GATE=1 DATABASE_URL=… npx tsx scripts/column-coverage.ts
 *
 * Run by ci.yml's `DB column coverage` job against `preview/pr-<N>` once the
 * Playwright suite and every iOS shard have finished. The preview's real rows
 * were wiped before it deployed (`wipe-preview-db.ts`), so every row and value
 * counted here came from fixtures and the tests. Sam, 2026-10-01: "we need to
 * be testing in a way that confirms every column / row of unique data type ...
 * every db table".
 *
 * For every base table in `public` (the kept tables included) it counts rows
 * and `count(column)` — non-null values — per column, and compares the gaps
 * with `e2e/column-coverage-baseline.json`, the gaps known today, each with a
 * reason. A table with no row is one gap; a column null in every row is one.
 *
 *  - A NEW gap (not in the baseline) fails the job when COVERAGE_GATE=1, which
 *    ci.yml sets only on the `ai-tests` run — the one that writes Penny's
 *    tables, and the one the deploy gate reads. Otherwise it is reported.
 *  - A FIXED gap (baselined, now covered) is a `::notice::` to shrink the
 *    baseline. Improvement never fails.
 *
 * It measures what is IN the database at the end, so rows a spec deletes in
 * its own cleanup do not count. Table and column names and counts only:
 * never the DATABASE_URL, never a value.
 */
import 'dotenv/config';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import {
  compareCoverage,
  parseBaseline,
  quoteIdent,
  renderCoverageSummary,
  type TableMeasure,
} from '../src/lib/columnCoverage';

const BASELINE = path.join(process.cwd(), 'e2e/column-coverage-baseline.json');

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('column-coverage: DATABASE_URL is not set.');
    return 1;
  }
  const gate = process.env.COVERAGE_GATE === '1';
  const baseline = parseBaseline(JSON.parse(readFileSync(BASELINE, 'utf8')));

  const sql = postgres(url, {
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : 'require',
    max: 1,
  });
  let measures: TableMeasure[];
  try {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position
    `;
    const byTable = new Map<string, string[]>();
    for (const c of cols) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
    if (byTable.size === 0) {
      console.error('column-coverage: found no tables in public — wrong database?');
      return 1;
    }
    measures = [];
    for (const [table, columns] of [...byTable].sort(([a], [b]) => a.localeCompare(b))) {
      // One scan per table: count(*) plus count(col) for every column, aliased
      // by position so a column name never has to be a valid alias.
      const select = ['count(*)::text as c_rows', ...columns.map((c, i) => `count(${quoteIdent(c)})::text as c${i}`)];
      const [row] = await sql.unsafe<Record<string, string>[]>(
        `select ${select.join(', ')} from public.${quoteIdent(table)}`,
      );
      measures.push({
        table,
        rows: Number(row.c_rows),
        columns: Object.fromEntries(columns.map((c, i) => [c, Number(row[`c${i}`])])),
      });
    }
  } catch (err) {
    console.error('column-coverage: failed —', err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await sql.end();
  }

  const cmp = compareCoverage(measures, baseline);
  const summary = renderCoverageSummary(measures, cmp, gate);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  for (const g of cmp.fixed) {
    console.log(`::notice::DB coverage: ${g} is covered now — remove it from e2e/column-coverage-baseline.json`);
  }
  for (const g of cmp.stale) {
    console.log(`::notice::DB coverage: baseline entry ${g} names no table or column — remove it`);
  }
  if (cmp.newGaps.length > 0) {
    const verb = gate ? 'error' : 'warning';
    for (const g of cmp.newGaps) {
      console.log(`::${verb}::DB coverage: ${g} — no test writes it. Cover it, or baseline it with a reason.`);
    }
    if (gate) return 1;
  }
  return 0;
}

main().then((code) => process.exit(code));
