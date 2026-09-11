import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An admin action that changes entitlement must never leave no row saying who
 * did it.
 *
 * There are exactly two of them — `revokeSubscription` and its undo — and until
 * 2026-09-10 the first wrote nothing to `subscription_events` at all. Its whole
 * record was three columns on the `subscriptions` row, which describe only the
 * LATEST revoke: a second revoke overwrites the first, and the undo clears them
 * outright. So the moment the undo shipped, the fact that a revoke had ever
 * happened became erasable by pressing a button — which is worse than the
 * missing feature it was fixing.
 *
 * Checked as SOURCE TEXT because the alternative is a database. Both functions
 * are two SQL statements around a pure decision; the pure halves are tested
 * properly in `reactivation.test.ts` and `states.test.ts`, and what is left to
 * defend is structural — that neither statement can be written without the
 * ledger write beside it.
 *
 * Mutation-checked: deleting either `recordAdminSubscriptionAction` call, or
 * moving one outside its transaction, reds this file.
 */

const SRC = join(__dirname, '..', 'server', 'payments', 'entitlements.ts');
const source = readFileSync(SRC, 'utf8');

/** The body of one exported function, up to the start of the next one. */
function bodyOf(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} is gone from entitlements.ts — has it moved?`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport (async )?function |\nasync function /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('admin entitlement actions leave a record', () => {
  for (const fn of ['revokeSubscription', 'reactivateSubscription']) {
    it(`${fn} writes a subscription_events row`, () => {
      expect(
        bodyOf(fn),
        `${fn} changes entitlement without recording who did it. The subscriptions ` +
          `row cannot hold that history: it describes the latest revoke only, and the ` +
          `undo clears it.`,
      ).toContain('recordAdminSubscriptionAction');
    });

    it(`${fn} does it in the same transaction as the write`, () => {
      // Outside the transaction, a failure between the two leaves the account's
      // access changed with nothing saying it was — the exact state this guard
      // exists to make impossible, arrived at by a crash instead of an edit.
      const body = bodyOf(fn);
      expect(body).toContain('db.transaction');
      expect(body.indexOf('db.transaction')).toBeLessThan(
        body.indexOf('recordAdminSubscriptionAction'),
      );
    });

    it(`${fn} demands a non-empty reason before it does anything`, () => {
      // Re-checked here as well as in the route's zod schema, so a second
      // caller — a script, a fixture endpoint — cannot skip it.
      expect(bodyOf(fn)).toMatch(/if \(!trimmed\) throw new Error/);
    });
  }

  it('the ledger write is the only way either of them records anything', () => {
    // One helper, so the payload shape of the pair cannot drift into two
    // different answers to "who did this, and why".
    const calls = source.match(/recordAdminSubscriptionAction\(/g) ?? [];
    // Two calls plus the declaration.
    expect(calls.length).toBe(3);
  });
});
