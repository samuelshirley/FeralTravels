import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `src/server/payments/` is a bounded module. Decision E1.
 *
 * A deliberate amendment to the `repos/` convention: a repo file is a shared
 * surface anything may call, and the entire value here is that the number of
 * places able to decide "this user has paid" stays at ONE. The public question
 * is `hasEntitlement(userId)`.
 *
 * The internals this protects are not obvious at a call site: cancelling does
 * not end access (they paid through `current_period_end`), the trial ends on
 * SPEND as well as age, and comped accounts skip the cap but still meter. A
 * route that re-derived any of that from the `subscriptions` table would look
 * reasonable and be wrong.
 */

const ROOT = join(__dirname, '..', '..');
const MODULE_DIR = 'src/server/payments';

/** Internals. `index.ts` is the public surface; `copy`/`testPurchase` are UI/ops seams. */
const PRIVATE = ['payments/states', 'payments/entitlements', 'payments/constants'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'src'))
  .map((f) => relative(ROOT, f).split('\\').join('/'))
  .filter((f) => !f.startsWith(MODULE_DIR + '/'));

describe('nothing outside payments/ reaches into it', () => {
  for (const priv of PRIVATE) {
    it(`no import of ${priv}`, () => {
      const hits = files.filter((f) => {
        const src = readFileSync(join(ROOT, f), 'utf8');
        return new RegExp(`from ['"]@/server/${priv}['"]`).test(src);
      });
      expect(
        hits,
        `Import from '@/server/payments' (the index) instead — one place decides who has paid.`,
      ).toEqual([]);
    });
  }

  it('nothing outside payments/ imports the subscriptions table', () => {
    const hits = files.filter((f) => {
      if (f.startsWith('src/server/db/')) return false;
      const src = readFileSync(join(ROOT, f), 'utf8');
      // The drizzle table object, not the word.
      return /import\s*\{[^}]*\bsubscriptions\b[^}]*\}\s*from\s*['"]@\/server\/db\/schema['"]/.test(src);
    });
    expect(hits, 'Entitlement questions go through payments/index, not the table.').toEqual([]);
  });

  it('the module still exposes the one public question', () => {
    const index = readFileSync(join(ROOT, MODULE_DIR, 'index.ts'), 'utf8');
    expect(index).toMatch(/hasEntitlement/);
  });
});
