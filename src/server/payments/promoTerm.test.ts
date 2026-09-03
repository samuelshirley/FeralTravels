import { describe, expect, it } from 'vitest';
import {
  addMonthsUTC,
  holdsLiveApplePurchase,
  isPromoGrantMonths,
  PROMO_GRANT_MONTHS,
} from '@/lib/promoCode';
import { resolveAccountState, type AccountFacts } from './states';

/**
 * Promo codes grant a fixed TERM, and the term expires on its own.
 *
 * The second half of that sentence is the part worth a test, because nothing
 * was written to make it true. `resolveAccountState` has a `periodOver` branch
 * that turns an `active` row with a past `current_period_end` into `expired` —
 * "the clock is the authority, not the stale status". It was written for a
 * renewal webhook that never arrived, and it happens to be exactly right for a
 * promo that has run out.
 *
 * So this file pins that behaviour FOR A PROMO ROW SPECIFICALLY. The branch is
 * now load-bearing for two features rather than one, and a future change that
 * made expiry depend on `autoRenew` or on `source` would still leave
 * `states.test.ts` green while silently giving every ambassador account
 * unlimited access.
 *
 * `promo.ts` itself needs a database, so what is tested here is the pure part:
 * the date arithmetic, the allowed terms, and the resolver's reaction to the
 * row a redemption writes.
 */

const NOW = new Date('2026-09-02T12:00:00.000Z');

/** The row `promoGrant()` writes, as `AccountFacts` sees it. */
function promoFacts(overrides: Partial<AccountFacts> = {}): AccountFacts {
  return {
    now: NOW,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    comped: false,
    anthropicMicrocents12mo: 0,
    subscription: {
      status: 'active',
      source: 'promo',
      productId: null,
      autoRenew: true,
      currentPeriodEnd: addMonthsUTC(NOW, 6),
    },
    ...overrides,
  };
}

describe('promo grant terms', () => {
  it('offers exactly the two the owner chose', () => {
    expect([...PROMO_GRANT_MONTHS]).toEqual([6, 12]);
    expect(isPromoGrantMonths(6)).toBe(true);
    expect(isPromoGrantMonths(12)).toBe(true);
    // The reason this is a guard and not free text: an admin typing 600 into a
    // months box is a mistake nobody notices for fifty years.
    expect(isPromoGrantMonths(600)).toBe(false);
    expect(isPromoGrantMonths(0)).toBe(false);
    expect(isPromoGrantMonths(6.5)).toBe(false);
  });
});

describe('addMonthsUTC', () => {
  it('adds whole months', () => {
    expect(addMonthsUTC(new Date('2026-09-02T12:00:00Z'), 6).toISOString()).toBe(
      '2027-03-02T12:00:00.000Z'
    );
    expect(addMonthsUTC(new Date('2026-09-02T12:00:00Z'), 12).toISOString()).toBe(
      '2027-09-02T12:00:00.000Z'
    );
  });

  it('clamps to the end of the target month instead of rolling over', () => {
    /**
     * `setUTCMonth` alone turns 31 August + 6 months into 31 February, which
     * JavaScript silently resolves to 3 March. A recipient told "six months"
     * getting three extra days is harmless; the same bug in the other direction
     * on a shorter month is not, and either way a date nobody can explain is a
     * support conversation.
     */
    expect(addMonthsUTC(new Date('2026-08-31T00:00:00Z'), 6).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z'
    );
    // A leap February still gets its 29th.
    expect(addMonthsUTC(new Date('2027-08-29T00:00:00Z'), 6).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    );
  });

  it('never moves the clock backwards', () => {
    for (const months of PROMO_GRANT_MONTHS) {
      expect(addMonthsUTC(NOW, months).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });
});

describe('a promo term expires without any new code', () => {
  it('entitles inside the term', () => {
    const v = resolveAccountState(promoFacts());
    expect(v.state).toBe('subscribed');
    expect(v.entitled).toBe(true);
    // And it carries the two facts Settings needs to say "Ambassador plan —
    // ends 2 Mar" rather than a bare "Subscribed".
    expect(v.source).toBe('promo');
    expect(v.currentPeriodEnd).not.toBeNull();
  });

  it('EXPIRES the moment the term is up, with the row still marked active', () => {
    /**
     * The whole point. Nothing sets `status: 'expired'` on a promo row — there
     * is no store, no webhook and no cron. The clock does it.
     */
    const ended = resolveAccountState(
      promoFacts({ now: new Date(addMonthsUTC(NOW, 6).getTime() + 1) })
    );
    expect(ended.state).toBe('expired');
    expect(ended.entitled).toBe(false);
    expect(ended.blockReason).toBe('subscription_over');
  });

  it('is still entitled one millisecond before the term ends', () => {
    // The boundary is `>=`, so the last instant of the term is still inside it.
    const almost = resolveAccountState(
      promoFacts({ now: new Date(addMonthsUTC(NOW, 6).getTime() - 1) })
    );
    expect(almost.state).toBe('subscribed');
  });

  it('does not depend on autoRenew, which a promo leaves TRUE', () => {
    /**
     * `autoRenew: true` on a promo is deliberate — `false` resolves to
     * `cancelled_in_period` and would tell the admin panel a story about a
     * cancellation that never happened. This asserts that choice costs nothing:
     * expiry is decided by the date, so the row still ends on time.
     */
    const ended = resolveAccountState(
      promoFacts({ now: new Date(addMonthsUTC(NOW, 6).getTime() + 1) })
    );
    expect(ended.state).toBe('expired');
    expect(ended.autoRenew).toBe(true);
  });

  it('would grant forever if the term were left null — the bug this replaced', () => {
    // Pinning the OLD behaviour as a contrast, so the reason for the column is
    // legible: an unlimited promo is entitled in the year 2099.
    const forever = resolveAccountState(
      promoFacts({
        now: new Date('2099-01-01T00:00:00Z'),
        subscription: {
          status: 'active',
          source: 'promo',
          productId: null,
          autoRenew: true,
          currentPeriodEnd: null,
        },
      })
    );
    expect(forever.state).toBe('subscribed');
  });
});

/**
 * The guard that stops a promo redemption overwriting a paying customer.
 *
 * The failure it prevents: `subscriptions` is one row per user, so redeeming a
 * code while an Apple subscription is live turns the `apple_iap` row into a
 * `promo` one — Apple keeps charging, and the next renewal webhook arrives
 * against a row that no longer carries the transaction id it is keyed to.
 *
 * It has to be exactly this narrow. Too wide and a lapsed customer can never be
 * given an ambassador plan, which is one of the main reasons to issue one.
 */
describe('holdsLiveApplePurchase', () => {
  const NOW_ = new Date('2026-09-02T12:00:00Z');
  const FUTURE = new Date('2027-01-01T00:00:00Z');
  const PAST = new Date('2026-01-01T00:00:00Z');

  it('protects a live Apple subscription', () => {
    for (const status of ['active', 'grace']) {
      expect(
        holdsLiveApplePurchase({ source: 'apple_iap', status, currentPeriodEnd: FUTURE }, NOW_),
        status
      ).toBe(true);
    }
  });

  it('protects a CANCELLED subscription that has not run out yet', () => {
    // Auto-renew is off, but they paid through the period, the row still
    // carries the original transaction id, and an UNCANCELLATION can still
    // land on it. Overwriting would lose all of that.
    expect(
      holdsLiveApplePurchase({ source: 'apple_iap', status: 'cancelled', currentPeriodEnd: FUTURE }, NOW_)
    ).toBe(true);
  });

  it('does NOT protect a lapsed customer — they can have an ambassador plan', () => {
    // The reason the test is "live" and not "has an apple_iap row at all".
    for (const status of ['expired', 'refunded', 'revoked']) {
      expect(
        holdsLiveApplePurchase({ source: 'apple_iap', status, currentPeriodEnd: PAST }, NOW_),
        status
      ).toBe(false);
    }
    // Nor one whose period simply ran out while the status went stale.
    expect(
      holdsLiveApplePurchase({ source: 'apple_iap', status: 'active', currentPeriodEnd: PAST }, NOW_)
    ).toBe(false);
  });

  it('does not protect rows that are not Apple purchases', () => {
    // A promo, an admin grant or a test purchase is ours to overwrite — there
    // is no store charging anybody and no webhook to strand.
    for (const source of ['promo', 'admin', 'fake']) {
      expect(
        holdsLiveApplePurchase({ source, status: 'active', currentPeriodEnd: FUTURE }, NOW_),
        source
      ).toBe(false);
    }
  });

  it('treats a null period end on an Apple row as live rather than clobbering it', () => {
    expect(
      holdsLiveApplePurchase({ source: 'apple_iap', status: 'active', currentPeriodEnd: null }, NOW_)
    ).toBe(true);
  });
});
