import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '@/server/db/schema';
import {
  compareCoverage,
  coverageGaps,
  KEEP_TABLES,
  parseBaseline,
  renderCoverageSummary,
  tablesToWipe,
  truncateStatement,
  wipeLeftovers,
  type TableMeasure,
} from './columnCoverage';

/**
 * The coverage ratchet (scripts/column-coverage.ts) and the wipe's table
 * arithmetic (scripts/wipe-preview-db.ts). The wipe's refusal guard and its
 * place in ci.yml are in previewWipeGuard.test.ts.
 */

const ROOT = path.resolve(__dirname, '../..');
const BASELINE_JSON = JSON.parse(readFileSync(path.join(ROOT, 'e2e/column-coverage-baseline.json'), 'utf8'));

/** Every table in schema.ts → its column names, as the database names them. */
const SCHEMA_TABLES = new Map(
  (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => v instanceof PgTable)
    .map((t) => {
      const c = getTableConfig(t);
      return [c.name, c.columns.map((col) => col.name)] as const;
    }),
);

const t = (table: string, rows: number, columns: Record<string, number>): TableMeasure => ({ table, rows, columns });

describe('the wipe: which tables, in one statement', () => {
  it('wipes every table but the kept ones, sorted and deduplicated', () => {
    expect(tablesToWipe(['users', 'app_meta', 'trips', 'oauth_provider_keys', 'users'])).toEqual(['trips', 'users']);
  });

  it('a table nobody has heard of is wiped (the list is read at runtime, never written by hand)', () => {
    expect(tablesToWipe(['brand_new_table'])).toEqual(['brand_new_table']);
  });

  it('keeps only tables that exist in schema.ts, and every one holds no user column', () => {
    for (const table of Object.keys(KEEP_TABLES)) {
      const cols = SCHEMA_TABLES.get(table);
      expect(cols, table).toBeDefined();
      expect(cols?.some((c) => /user|email/i.test(c)), `${table} has a user/email column`).toBe(false);
    }
  });

  it('is one TRUNCATE, identifiers quoted, identities reset, cascading', () => {
    expect(truncateStatement(['users', 'verificationTokens', 'we"ird'])).toBe(
      'TRUNCATE TABLE public."users", public."verificationTokens", public."we""ird" RESTART IDENTITY CASCADE',
    );
    expect(() => truncateStatement([])).toThrow();
  });

  it('reports any wiped table with rows, and any table with rows outside public', () => {
    expect(wipeLeftovers({ users: 0, trips: 0, app_meta: 3, oauth_provider_keys: 2 })).toEqual([]);
    expect(wipeLeftovers({ users: 2, trips: 0, app_meta: 3 }, { 'neon_auth.users_sync': 5, 'x.empty': 0 })).toEqual([
      'neon_auth.users_sync (5 rows; not in public, so not wiped)',
      'public.users (2 rows)',
    ]);
  });
});

describe('coverage gaps', () => {
  it('an empty table is one gap; a column null in every row is one gap', () => {
    expect(
      coverageGaps([
        t('tasks', 0, { id: 0, title: 0 }),
        t('users', 3, { id: 3, name: 0, email: 3 }),
      ]),
    ).toEqual(['tasks', 'users.name']);
  });
});

describe('compareCoverage: new, fixed, known, stale', () => {
  const base = parseBaseline({
    entries: [
      { gap: 'gone_table', reason: 'r' },
      { gap: 'stops.photos', reason: 'dormant' },
      { gap: 'tasks', reason: 'r' },
      { gap: 'users.name', reason: 'r' },
    ],
  });

  it('a gap not in the baseline is NEW; one in it is known', () => {
    const cmp = compareCoverage(
      [t('users', 1, { id: 1, name: 0, image: 0 }), t('tasks', 0, { id: 0 }), t('stops', 1, { photos: 0 })],
      base,
    );
    expect(cmp.newGaps).toEqual(['users.image']);
    expect(cmp.known).toEqual(['stops.photos', 'tasks', 'users.name']);
    expect(cmp.fixed).toEqual([]);
    expect(cmp.stale).toEqual(['gone_table']);
  });

  it('a baselined gap that is covered now is FIXED, never a failure', () => {
    const cmp = compareCoverage([t('users', 1, { id: 1, name: 1 }), t('tasks', 0, {}), t('stops', 1, { photos: 0 })], base);
    expect(cmp.fixed).toEqual(['users.name']);
    expect(cmp.newGaps).toEqual([]);
  });

  it("a baselined table that gains rows is FIXED, and its column gaps stay excused until the baseline is narrowed", () => {
    const cmp = compareCoverage(
      [t('tasks', 2, { id: 2, answer: 0 }), t('users', 1, { name: 0 }), t('stops', 1, { photos: 0 })],
      base,
    );
    expect(cmp.fixed).toEqual(['tasks']);
    expect(cmp.known).toContain('tasks.answer');
    expect(cmp.newGaps).toEqual([]);
  });

  it('a baselined column in a table with no rows is not fixed: the empty table is the gap', () => {
    const b = parseBaseline({ entries: [{ gap: 'deleted_users.email_encrypted', reason: 'r' }] });
    const cmp = compareCoverage([t('deleted_users', 0, { id: 0, email_encrypted: 0 })], b);
    expect(cmp.fixed).toEqual([]);
    expect(cmp.newGaps).toEqual(['deleted_users']);
  });

  it('the summary says which mode it ran in and lists the new gaps', () => {
    const measures = [t('users', 1, { id: 1, image: 0 })];
    const md = renderCoverageSummary(measures, compareCoverage(measures, parseBaseline({ entries: [] })), true);
    expect(md).toContain('Gate **ON**');
    expect(md).toContain('| Tables with ≥1 row | 1 | 1 |');
    expect(md).toContain('| Columns with ≥1 non-null value | 1 | 2 |');
    expect(md).toContain('- `users.image`');
  });
});

describe('the committed baseline', () => {
  const baseline = parseBaseline(BASELINE_JSON);

  it('parses: sorted, no duplicates, every entry has a reason', () => {
    expect(baseline.entries.length).toBeGreaterThan(0);
  });

  it('names only tables and columns that exist in schema.ts', () => {
    const unknown = baseline.entries
      .map((e) => e.gap)
      .filter((g) => {
        const [table, col] = g.split('.');
        const cols = SCHEMA_TABLES.get(table);
        return !cols || (col !== undefined && !cols.includes(col));
      });
    expect(unknown).toEqual([]);
  });

  it('parseBaseline refuses an unsorted, duplicated or reasonless file', () => {
    expect(() => parseBaseline({ entries: [{ gap: 'b', reason: 'r' }, { gap: 'a', reason: 'r' }] })).toThrow(/sorted/);
    expect(() => parseBaseline({ entries: [{ gap: 'a', reason: 'r' }, { gap: 'a', reason: 'r' }] })).toThrow(/duplicate/);
    expect(() => parseBaseline({ entries: [{ gap: 'a', reason: '' }] })).toThrow();
    expect(() => parseBaseline({ entries: [{ gap: 'a; drop table users', reason: 'r' }] })).toThrow();
  });
});
