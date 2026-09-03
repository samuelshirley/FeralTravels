import { describe, it, expect, vi } from 'vitest';

// `server-only` throws outside a React Server Component, and the switch now
// reads a row so it imports the db client too. Both hoisted above the import,
// same as webhook.test.ts — nothing here touches Postgres.
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {}, schema: {} }));

import { paywallEnabledFromValue, PAYWALL_META_KEY } from './switch';

/**
 * The paywall's master switch, as a rule rather than as a query.
 *
 * It moved out of `process.env` and into `app_meta` on 2026-09-02, so this file
 * changed shape with it: the old version passed fake env objects to a pure
 * lookup, and the new one tests the only part that is still pure — what a
 * stored value MEANS. The database read around it is four lines of drizzle,
 * and a mocked query builder would assert that we called drizzle the way we
 * called drizzle. `webhook.test.ts` explains the same trade at length.
 *
 * What is worth pinning is the direction of every ambiguity: OFF. This switch
 * blocks paying customers when it is wrong, and it blocked 28 of 29 production
 * accounts once already.
 */
describe('paywallEnabledFromValue', () => {
  it('is ON for exactly "1" and nothing else', () => {
    expect(paywallEnabledFromValue('1')).toBe(true);
  });

  it('is OFF for every other truthy-looking string', () => {
    /**
     * The failure this prevents: somebody sets the row by hand — from psql, or
     * from a future admin form that posts a string — and types the word they
     * would say out loud. A loose check (`Boolean(value)`, or `!== '0'`) turns
     * every one of these into an enforced paywall, which is the expensive
     * direction.
     */
    for (const v of ['true', 'TRUE', 'yes', 'on', 'enabled', '2', ' 1', '1 ', '01']) {
      expect(paywallEnabledFromValue(v), v).toBe(false);
    }
  });

  it('is OFF for absent, empty and null — the states a fresh database is in', () => {
    // No row at all is the normal state of a database that has never had the
    // switch touched, including every preview branch and every local checkout.
    expect(paywallEnabledFromValue(undefined)).toBe(false);
    expect(paywallEnabledFromValue(null)).toBe(false);
    expect(paywallEnabledFromValue('')).toBe(false);
    expect(paywallEnabledFromValue('0')).toBe(false);
  });

  it('names the row it reads', () => {
    // Pinned because two places write it: `setPaywallEnabled` and any hand fix
    // from psql when the admin page itself is the thing that is broken.
    expect(PAYWALL_META_KEY).toBe('paywall_enabled');
  });
});
