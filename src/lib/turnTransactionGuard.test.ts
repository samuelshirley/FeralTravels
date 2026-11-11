import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A Penny turn's dispatch is ONE database transaction, and nothing can write
 * around it.
 *
 * WHY (2026-11-11, follow-up to trip 65972b73): an action that passed every
 * pre-dispatch gate and then threw left every action ahead of it written —
 * half an edit under Penny's "Done". The route now dispatches inside
 * `runInTurnTransaction` (src/server/db/turnScope.ts), and the exported `db` is
 * a proxy that resolves to that transaction in the turn's async context. That
 * only holds while every write goes through that `db`. This guard pins the
 * places it could leak:
 *
 *  1. Only client.ts constructs a database client. A second driver import is a
 *     second handle that would write outside the transaction (and survive its
 *     rollback) with nothing to say so.
 *  2. client.ts exports the SCOPED db, and the PGlite harness scopes exactly
 *     the same way, so the transaction tests exercise production semantics.
 *  3. Every usage_events write in app code (usage.ts, repos/jev.ts, …) is
 *     deferred until the transaction settles —
 *     accounting records spend that happened; it must survive a rollback.
 *  4. Every paid Google wrapper refuses to run inside a turn transaction, and
 *     dispatch itself makes no Google call: paid calls run after commit.
 *  5. The replan route calls dispatchAction exactly once, inside the
 *     transaction callback.
 *
 * Registered in docs/decisions.md. Prose: docs/design/penny-tools.md.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const DRIVERS = [
  'postgres',
  'pg',
  '@neondatabase/serverless',
  '@electric-sql/pglite',
  'drizzle-orm/postgres-js',
  'drizzle-orm/neon-http',
  'drizzle-orm/neon-serverless',
  'drizzle-orm/node-postgres',
  'drizzle-orm/pglite',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(relative(ROOT, p));
    }
  }
  return out;
}

/** App code — not tests, not the PGlite test harness. */
const appFiles = walk(join(ROOT, 'src')).filter(
  (f) => !/\.test\.tsx?$/.test(f) && !f.startsWith('src/test/'),
);

function importsDriver(src: string): string[] {
  const found: string[] = [];
  for (const d of DRIVERS) {
    const re = new RegExp(`(from|import\\(|require\\()\\s*['"]${d.replace('/', '\\/')}['"]`);
    if (re.test(src)) found.push(d);
  }
  return found;
}

describe('a Penny turn transaction cannot be written around', () => {
  it('only src/server/db/client.ts constructs a database client', () => {
    const offenders = appFiles
      .map((f) => [f, importsDriver(read(f))] as const)
      .filter(([, d]) => d.length > 0)
      .map(([f, d]) => `${f}: ${d.join(', ')}`);
    expect(offenders).toEqual(['src/server/db/client.ts: postgres, drizzle-orm/postgres-js']);
  });

  it('client.ts exports the scoped db and nothing else that can write', () => {
    const src = read('src/server/db/client.ts');
    expect(src).toMatch(/export const db = scopedDb\(rootDb\);/);
    expect(src).not.toMatch(/export\s+(const|let|function)\s+(rootDb|client)\b/);
    expect(src).not.toMatch(/export\s*\{[^}]*\b(rootDb|client)\b/);
  });

  it('the PGlite harness scopes its client exactly as production does', () => {
    expect(read('src/test/pg/harness.ts')).toMatch(/return \{ db: scopedDb\(db\), schema \};/);
  });

  it('every usage_events write in app code is deferred until the turn transaction settles', () => {
    // Accounting records something that happened (spend, a logged idea, a Jev
    // measurement); a rolled-back turn must not erase it. Not just usage.ts:
    // main's Jev compare rows (repos/jev.ts, #100) write usage_events too.
    const ALLOWED: Record<string, string> = {
      // Anonymises rows as part of deleting an account, inside that delete's
      // own transaction — it must roll back with it.
      'src/server/repos/accountDeletion.ts': 'part of the account-deletion transaction',
      // Fixture data behind E2E_TEST_ENDPOINTS / test accounts — never a turn.
      'src/server/repos/testSupport.ts': 'test fixtures only',
      'src/server/payments/testAccounts.ts': 'test accounts only',
    };
    const undeferred: string[] = [];
    let writers = 0;
    for (const f of appFiles) {
      if (ALLOWED[f]) continue;
      const src = read(f);
      for (const m of src.matchAll(/\.\s*(insert|update|delete)\(\s*usageEvents\s*\)/g)) {
        writers += 1;
        // The write's own expression must open with `deferUntilSettled(() =>`.
        const before = src.slice(Math.max(0, m.index! - 80), m.index!);
        if (!/deferUntilSettled\(\(\) =>\s*db\s*$/.test(before)) {
          undeferred.push(`${f}:${src.slice(0, m.index!).split('\n').length}`);
        }
      }
    }
    expect(writers).toBeGreaterThanOrEqual(8);
    expect(undeferred).toEqual([]);
  });

  it('every paid Google wrapper refuses to run inside a turn transaction', () => {
    const src = read('src/server/google/accounted.ts');
    const fns = [...src.matchAll(/export async function (\w+)\([\s\S]*?\): Promise<[^>]+>\s*\{\n\s*(.*)\n/g)];
    expect(fns.map((m) => m[1]).sort()).toEqual([
      'fetchPlaceDisplayNameAccounted',
      'geocodePlaceAccounted',
      'getDirectionsAccounted',
      'searchFuelAlongRouteAccounted',
    ]);
    for (const m of fns) expect(m[2], m[1]).toMatch(/^assertNoTurnTransaction\(/);
  });

  it('the replan route dispatches once, inside the transaction, and dispatch makes no Google call', () => {
    const src = read('src/app/api/trip/replan/route.ts');
    const calls = [...src.matchAll(/await dispatchAction\(/g)];
    expect(calls).toHaveLength(1);
    const open = src.indexOf('await runInTurnTransaction(db, async () => {');
    expect(open).toBeGreaterThan(-1);
    const call = calls[0].index!;
    expect(call).toBeGreaterThan(open);
    // Nothing closes the callback between its opening and the call.
    expect(src.slice(open, call)).not.toMatch(/\n\s{14}\}\);/);

    const body = src.slice(src.indexOf('async function dispatchAction('));
    expect(body).not.toMatch(
      /(getDirectionsAccounted|geocodePlaceAccounted|searchFuelAlongRouteAccounted|fetchPlaceDisplayNameAccounted)\(/,
    );
  });
});
