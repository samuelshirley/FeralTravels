import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

// `server-only` throws outside a React Server Component, and the switch now
// reads a row so it imports the db client too. Both hoisted above the import,
// same as webhook.test.ts — nothing here touches Postgres.
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {}, schema: {} }));

import {
  enforcementApplies,
  paywallEnabledFromValue,
  pennyLockedFromValue,
  PAYWALL_META_KEY,
  PENNY_LOCK_META_KEY,
} from './switch';

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

/**
 * The two ways to be enforced, as a rule rather than as two queries.
 *
 * These exist because the per-account override was added for one purpose — to
 * prove the wall works while the global switch stays off for the web demo —
 * and every one of these cases is a way that purpose could be quietly lost.
 */
describe('enforcementApplies', () => {
  it('enforces on the override alone, which is the whole point', () => {
    // The demo case: the deployment-wide switch is off because the web app is
    // what is being shown to people, and this one test account is walled
    // anyway. If this ever returns false the feature has no reason to exist.
    expect(enforcementApplies({ globalOn: false, forcedForUser: true })).toBe(true);
  });

  it('enforces on the global switch alone', () => {
    // Launch day: the switch goes on and every account is enforced without
    // anybody visiting a row. An AND here would mean per-account opt-in to a
    // paywall, which is not a paywall.
    expect(enforcementApplies({ globalOn: true, forcedForUser: false })).toBe(true);
  });

  it('enforces when both are set', () => {
    expect(enforcementApplies({ globalOn: true, forcedForUser: true })).toBe(true);
  });

  it('enforces nobody when neither is set — the state production is in today', () => {
    // 28 of 29 production accounts were blocked the instant the paywall
    // deployed, none of them told a trial existed and none able to pay. This
    // is the case that must never drift.
    expect(enforcementApplies({ globalOn: false, forcedForUser: false })).toBe(false);
  });
});


/**
 * The manual Penny lock. Same shape as the paywall switch, opposite fail
 * direction, and the direction is the only thing worth a test.
 */
describe('pennyLockedFromValue', () => {
  it('is LOCKED for exactly "1" and nothing else', () => {
    expect(pennyLockedFromValue('1')).toBe(true);
  });

  it('is unlocked for every other value, including a missing row', () => {
    // A deployment that has never been locked has no row at all, and that has
    // to read as "open for business" — the same "one exact string" rule the
    // paywall switch follows, pointing the other way.
    for (const v of ['0', 'true', 'yes', 'on', ' 1', '', null, undefined]) {
      expect(pennyLockedFromValue(v), `value ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('reads a different app_meta row from the paywall', () => {
    // One key/value table, two switches. Sharing a key would make throwing one
    // of them silently throw the other.
    expect(PENNY_LOCK_META_KEY).toBe('penny_locked');
    expect(PENNY_LOCK_META_KEY).not.toBe(PAYWALL_META_KEY);
  });
});

describe('the two switches fail in OPPOSITE directions, on purpose', () => {
  it('says so in the source, beside the code that does it', () => {
    // Not decoration. The next person to touch either read will reach for
    // consistency, and consistency is the bug here: the paywall failing closed
    // walls paying users, and the lock failing open is a bypass during exactly
    // the minutes an attack is straining the database.
    const src = readFileSync(join(__dirname, 'switch.ts'), 'utf8');
    expect(src).toMatch(/treating as OFF/);
    expect(src).toMatch(/treating as LOCKED/);
  });
});
