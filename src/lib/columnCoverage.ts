/**
 * The PR preview database: what it may hold, and what the tests prove about it.
 *
 * Pure logic for two CI scripts, kept here so it can be unit-tested:
 *
 *  - `scripts/wipe-preview-db.ts` empties `preview/pr-<N>` after the migration
 *    rehearsal and before anything deploys (Sam, 2026-09-30/10-01: previews
 *    hold no customer data; fresh fixture data is fine). Its guard — the one
 *    thing standing between a TRUNCATE and the wrong database — is here.
 *  - `scripts/column-coverage.ts` measures, after every test has run, which
 *    tables have a row and which columns have a non-null value. With the real
 *    rows gone, everything it finds was written by fixtures and the tests
 *    themselves, so a column nobody writes is a column nobody tests (Sam:
 *    "every column / row of unique data type ... every db table").
 *
 * Nothing in this file touches a database.
 */
import { z } from 'zod';

// ── The wipe ────────────────────────────────────────────────────────────────

/** The only Neon branch names the wipe will run against: one PR's preview. */
export const PREVIEW_BRANCH_RE = /^preview\/pr-[1-9][0-9]*$/;

/**
 * Why the wipe must NOT run, or null when it may.
 *
 * Two variables, both required, both equal: `NEON_BRANCH` (set for the whole
 * of ci.yml) and `PREVIEW_DB_WIPE_CONFIRM` (set on the wipe step alone). The
 * DATABASE_URL cannot say which branch it points at — the host is an opaque
 * endpoint id — so the name has to be stated, twice, by the workflow that
 * created the branch. A developer shell, a prod deploy and a local database
 * carry neither, so the script refuses there before it connects.
 */
export function previewWipeRefusal(env: {
  neonBranch?: string | undefined;
  confirm?: string | undefined;
}): string | null {
  const confirm = env.confirm?.trim() ?? '';
  const branch = env.neonBranch?.trim() ?? '';
  if (!confirm) return 'PREVIEW_DB_WIPE_CONFIRM is not set';
  if (!branch) return 'NEON_BRANCH is not set';
  if (confirm !== branch) return 'PREVIEW_DB_WIPE_CONFIRM does not equal NEON_BRANCH';
  if (!PREVIEW_BRANCH_RE.test(branch)) {
    return `NEON_BRANCH "${branch}" is not a PR preview branch (preview/pr-<N>)`;
  }
  return null;
}

/**
 * Tables the wipe leaves alone. Each holds no personal data, and each is
 * something the deployed preview needs from prod rather than from a test.
 * Every other table in `public` is wiped, including ones added after this
 * list was written: the wipe lists tables at runtime, so forgetting this file
 * fails safe. When unsure, a table does NOT go here.
 */
export const KEEP_TABLES: Readonly<Record<string, string>> = {
  // Deployment switches (`paywall_enabled`, `penny_locked`, `jev_mode`) and
  // one-off migration markers: key → value, nobody's data. Kept so a preview
  // runs with prod's switches; CI then sets the paywall on explicitly.
  app_meta: 'deployment switches; no personal data',
  // Apple's and Google's PUBLIC signing keys, the fallback when a live JWKS
  // fetch fails. Nothing secret and nothing about a user.
  oauth_provider_keys: 'OAuth providers’ public signing keys; no personal data',
};

export const isKeptTable = (table: string): boolean =>
  Object.prototype.hasOwnProperty.call(KEEP_TABLES, table);

/** Every table the wipe empties, sorted. */
export function tablesToWipe(publicTables: readonly string[]): string[] {
  return [...new Set(publicTables)].filter((t) => !isKeptTable(t)).sort();
}

/** A Postgres identifier, double-quoted, with any embedded quote doubled. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** ONE statement, so the wipe is all-or-nothing. */
export function truncateStatement(tables: readonly string[]): string {
  if (tables.length === 0) throw new Error('nothing to truncate');
  const list = tables.map((t) => `public.${quoteIdent(t)}`).join(', ');
  return `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`;
}

/**
 * What survived the wipe: every non-kept public table with rows, plus any
 * table with rows in a schema the wipe does not own. Names only, never rows.
 * Empty means the preview may deploy.
 */
export function wipeLeftovers(
  publicCounts: Readonly<Record<string, number>>,
  otherSchemaCounts: Readonly<Record<string, number>> = {},
): string[] {
  const left = Object.entries(publicCounts)
    .filter(([t, n]) => !isKeptTable(t) && n > 0)
    .map(([t, n]) => `public.${t} (${n} rows)`);
  const other = Object.entries(otherSchemaCounts)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} (${n} rows; not in public, so not wiped)`);
  return [...left, ...other].sort();
}

// ── Coverage ────────────────────────────────────────────────────────────────

/** One table as measured: its row count and each column's non-null count. */
export type TableMeasure = {
  table: string;
  rows: number;
  columns: Record<string, number>;
};

/**
 * A gap is `table` (no row at all) or `table.column` (rows, but this column
 * is null in every one). A table with no rows is ONE gap, not one per column.
 */
export function coverageGaps(measures: readonly TableMeasure[]): string[] {
  const gaps: string[] = [];
  for (const m of measures) {
    if (m.rows === 0) {
      gaps.push(m.table);
      continue;
    }
    for (const [col, n] of Object.entries(m.columns)) {
      if (n === 0) gaps.push(`${m.table}.${col}`);
    }
  }
  return gaps.sort();
}

const baselineSchema = z.object({
  entries: z.array(
    z.object({
      // `verificationTokens` and `accounts.userId`: Auth.js's camelCase names.
      gap: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/),
      reason: z.string().min(1),
    }).strict(),
  ),
}).strict();

export type Baseline = z.infer<typeof baselineSchema>;

/** Parse the committed baseline; throws on a malformed or unsorted file. */
export function parseBaseline(json: unknown): Baseline {
  const b = baselineSchema.parse(json);
  const ids = b.entries.map((e) => e.gap);
  const sorted = [...ids].sort();
  if (ids.join('\n') !== sorted.join('\n')) throw new Error('baseline entries are not sorted by gap');
  if (new Set(ids).size !== ids.length) throw new Error('baseline has a duplicate gap');
  return b;
}

export type CoverageComparison = {
  /** Uncovered now and not in the baseline: the regressions. */
  newGaps: string[];
  /** In the baseline and covered now: shrink the baseline. */
  fixed: string[];
  /** Uncovered and expected to be. */
  known: string[];
  /** Baseline entries naming a table or column that no longer exists. */
  stale: string[];
};

/**
 * Compare measured gaps against the baseline.
 *
 * A whole-table baseline entry also excuses that table's COLUMN gaps once the
 * table gains rows: a test that starts writing a table should be able to land
 * without covering every column in the same PR. The table entry then shows as
 * fixed, which asks for it to be replaced by the column entries that remain.
 */
export function compareCoverage(
  measures: readonly TableMeasure[],
  baseline: Baseline,
): CoverageComparison {
  const gaps = coverageGaps(measures);
  const base = new Set(baseline.entries.map((e) => e.gap));
  const exists = new Set<string>();
  const covered = new Set<string>();
  for (const m of measures) {
    exists.add(m.table);
    if (m.rows > 0) covered.add(m.table);
    for (const [c, n] of Object.entries(m.columns)) {
      exists.add(`${m.table}.${c}`);
      if (m.rows > 0 && n > 0) covered.add(`${m.table}.${c}`);
    }
  }
  const newGaps: string[] = [];
  const known: string[] = [];
  for (const g of gaps) {
    const table = g.split('.')[0];
    if (base.has(g) || base.has(table)) known.push(g);
    else newGaps.push(g);
  }
  const fixed: string[] = [];
  const stale: string[] = [];
  for (const g of base) {
    if (!exists.has(g)) stale.push(g);
    else if (covered.has(g)) fixed.push(g);
  }
  return { newGaps, fixed: fixed.sort(), known, stale: stale.sort() };
}

/** The run summary: totals, then each list that is not empty. */
export function renderCoverageSummary(
  measures: readonly TableMeasure[],
  cmp: CoverageComparison,
  gate: boolean,
): string {
  const tables = measures.length;
  const tablesCovered = measures.filter((m) => m.rows > 0).length;
  const columns = measures.reduce((n, m) => n + Object.keys(m.columns).length, 0);
  const columnsCovered = measures.reduce(
    (n, m) => n + Object.values(m.columns).filter((c) => c > 0).length,
    0,
  );
  const lines = [
    '## 🗄️ DB column coverage',
    '',
    `Measured on this PR's preview database after every test ran. Real rows are wiped before deploy, so everything counted here was written by fixtures and the tests themselves. ${gate ? 'Gate **ON**: a new gap fails this job.' : 'Report only (the gate runs on the `ai-tests` run).'}`,
    '',
    '| | Covered | Total |',
    '|---|---|---|',
    `| Tables with ≥1 row | ${tablesCovered} | ${tables} |`,
    `| Columns with ≥1 non-null value | ${columnsCovered} | ${columns} |`,
    '',
  ];
  const list = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`### ${title} (${items.length})`, '', ...items.map((i) => `- \`${i}\``), '');
  };
  list('New gaps: not covered, not in the baseline', cmp.newGaps);
  list('Fixed: covered now, remove from e2e/column-coverage-baseline.json', cmp.fixed);
  list('Stale baseline entries: no such table or column', cmp.stale);
  list('Known gaps (baseline)', cmp.known);
  return lines.join('\n');
}
