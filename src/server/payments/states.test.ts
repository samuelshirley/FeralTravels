import { describe, expect, it } from 'vitest';
import {
  dollars,
  STOP_MICROCENTS,
  TRIAL_CEILING_MICROCENTS,
  TRIAL_DAYS,
  WATCH_MICROCENTS,
} from './constants';
import {
  resolveAccountState,
  trialDaysRemaining,
  trialEndsAt,
  type AccountFacts,
  type AccountState,
} from './states';

/**
 * The twelve states of docs/design/subscriptions.md, pinned.
 *
 * Every case fixes `now` explicitly — the resolver takes the clock as an input
 * precisely so a test can describe a moment instead of waiting for one, and a
 * `Date.now()` in here would put the suite back on the real calendar.
 *
 * Thresholds are IMPORTED, not written as literals. These numbers are unit
 * economics (see constants.ts), and a price change should move the tests with
 * it rather than leave a green suite asserting last quarter's paywall.
 */

const NOW = new Date('2026-08-26T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** A `createdAt` this many milliseconds before the fixed `now`. */
function agedBy(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function facts(overrides: Partial<AccountFacts> = {}): AccountFacts {
  return {
    now: NOW,
    createdAt: agedBy(DAY_MS),
    comped: false,
    anthropicMicrocents12mo: 0,
    subscription: null,
    ...overrides,
  };
}

/** An entitled, paid-up subscription row. Individual cases bend one field. */
function activeSub(overrides: Partial<NonNullable<AccountFacts['subscription']>> = {}) {
  return {
    status: 'active' as const,
    currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY_MS),
    autoRenew: true,
    ...overrides,
  };
}

/** The four fields every state has to answer for. */
function verdictOf(f: AccountFacts) {
  const v = resolveAccountState(f);
  return {
    state: v.state,
    entitled: v.entitled,
    canViewExistingTrips: v.canViewExistingTrips,
    blockReason: v.blockReason,
  };
}

describe('resolveAccountState — every state in the table', () => {
  it('1. trial — young account, nothing spent', () => {
    expect(verdictOf(facts())).toEqual({
      state: 'trial',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('2. trial_spent — inside the week but over the ceiling', () => {
    expect(
      verdictOf(facts({ anthropicMicrocents12mo: TRIAL_CEILING_MICROCENTS }))
    ).toEqual({
      state: 'trial_spent',
      entitled: false,
      canViewExistingTrips: true,
      blockReason: 'trial_over',
    });
  });

  it('3. trial_expired — past the week, never subscribed', () => {
    expect(verdictOf(facts({ createdAt: agedBy(30 * DAY_MS) }))).toEqual({
      state: 'trial_expired',
      entitled: false,
      canViewExistingTrips: true,
      blockReason: 'trial_over',
    });
  });

  it('4. subscribed — active row, spend under the watch line', () => {
    expect(verdictOf(facts({ subscription: activeSub() }))).toEqual({
      state: 'subscribed',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('5. subscribed_watch — over the alert line, still full access', () => {
    expect(
      verdictOf(
        facts({ subscription: activeSub(), anthropicMicrocents12mo: WATCH_MICROCENTS })
      )
    ).toEqual({
      state: 'subscribed_watch',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('6. subscribed_capped — over the stop line, soft block', () => {
    expect(
      verdictOf(
        facts({ subscription: activeSub(), anthropicMicrocents12mo: STOP_MICROCENTS })
      )
    ).toEqual({
      state: 'subscribed_capped',
      entitled: false,
      // A capped account is a cost problem, never a conduct one: their trips
      // stay readable and the copy points at support.
      canViewExistingTrips: true,
      blockReason: 'usage_cap',
    });
  });

  it('7. cancelled_in_period — auto-renew off, period still running', () => {
    expect(verdictOf(facts({ subscription: activeSub({ status: 'cancelled' }) }))).toEqual({
      state: 'cancelled_in_period',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('8. expired — the paid period has ended', () => {
    expect(verdictOf(facts({ subscription: activeSub({ status: 'expired' }) }))).toEqual({
      state: 'expired',
      entitled: false,
      canViewExistingTrips: true,
      blockReason: 'subscription_over',
    });
  });

  it('9. billing_grace — renewal failed, Apple retrying', () => {
    expect(verdictOf(facts({ subscription: activeSub({ status: 'grace' }) }))).toEqual({
      state: 'billing_grace',
      // Entitled on purpose: grace only ever applies to someone who already
      // paid successfully at least once, so there is no free-access path here.
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('10. refunded — money returned, everything closes', () => {
    expect(verdictOf(facts({ subscription: activeSub({ status: 'refunded' }) }))).toEqual({
      state: 'refunded',
      entitled: false,
      canViewExistingTrips: false,
      blockReason: 'revoked',
    });
  });

  it('11. revoked — admin break-glass', () => {
    expect(verdictOf(facts({ subscription: activeSub({ status: 'revoked' }) }))).toEqual({
      state: 'revoked',
      entitled: false,
      canViewExistingTrips: false,
      blockReason: 'revoked',
    });
  });

  it('12. comped — allowlisted account', () => {
    expect(verdictOf(facts({ comped: true }))).toEqual({
      state: 'comped',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('covers every member of AccountState', () => {
    // A new state added to the union without a case above should fail here
    // rather than ship untested — the doc's rule is "every one needs a test".
    const covered: AccountState[] = [
      'trial',
      'trial_spent',
      'trial_expired',
      'subscribed',
      'subscribed_watch',
      'subscribed_capped',
      'cancelled_in_period',
      'expired',
      'billing_grace',
      'refunded',
      'revoked',
      'comped',
    ];
    expect(new Set(covered).size).toBe(12);
  });
});

describe('the 7-day trial boundary', () => {
  it('is still trial one minute before the deadline', () => {
    const f = facts({ createdAt: agedBy(TRIAL_DAYS * DAY_MS - MINUTE_MS) });
    expect(resolveAccountState(f).state).toBe('trial');
  });

  it('is still trial at 6d23h59m', () => {
    const f = facts({ createdAt: agedBy(6 * DAY_MS + 23 * HOUR_MS + 59 * MINUTE_MS) });
    expect(resolveAccountState(f).state).toBe('trial');
  });

  it('expires at exactly 7d00m00s — the comparison is >=, not >', () => {
    const f = facts({ createdAt: agedBy(TRIAL_DAYS * DAY_MS) });
    expect(resolveAccountState(f).state).toBe('trial_expired');
  });

  it('reports trialEndsAt while the trial is live, and after it lapses', () => {
    const createdAt = agedBy(2 * DAY_MS);
    expect(resolveAccountState(facts({ createdAt })).trialEndsAt).toEqual(
      trialEndsAt(createdAt)
    );
    const stale = agedBy(30 * DAY_MS);
    expect(resolveAccountState(facts({ createdAt: stale })).trialEndsAt).toEqual(
      trialEndsAt(stale)
    );
  });

  it('drops trialEndsAt once a subscription exists', () => {
    expect(resolveAccountState(facts({ subscription: activeSub() })).trialEndsAt).toBeNull();
  });
});

describe('the trial ends on spend, not only on age', () => {
  it('$1.20 at three days old is over — the cap fires before the calendar does', () => {
    const f = facts({
      createdAt: agedBy(3 * DAY_MS),
      anthropicMicrocents12mo: dollars(1.2),
    });
    expect(verdictOf(f)).toEqual({
      state: 'trial_spent',
      entitled: false,
      canViewExistingTrips: true,
      blockReason: 'trial_over',
    });
  });

  it('$0.99 at three days old is still a trial', () => {
    const f = facts({
      createdAt: agedBy(3 * DAY_MS),
      anthropicMicrocents12mo: dollars(0.99),
    });
    expect(resolveAccountState(f).state).toBe('trial');
  });

  it('the ceiling itself is spent, not free', () => {
    const f = facts({ anthropicMicrocents12mo: TRIAL_CEILING_MICROCENTS - 1 });
    expect(resolveAccountState(f).state).toBe('trial');
    expect(
      resolveAccountState(facts({ anthropicMicrocents12mo: TRIAL_CEILING_MICROCENTS })).state
    ).toBe('trial_spent');
  });
});

describe('cancellation is not a block', () => {
  // The regression this whole file exists to prevent. The original plan cut
  // access off the moment auto-renew went off — which is keeping the money
  // (cancelling refunds nothing) while withholding the product.
  it('status "cancelled" inside the period keeps full access', () => {
    const f = facts({ subscription: activeSub({ status: 'cancelled', autoRenew: false }) });
    expect(verdictOf(f)).toEqual({
      state: 'cancelled_in_period',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('an "active" row with autoRenew false is the same thing', () => {
    // Both spellings reach us in practice: RevenueCat flips the flag, Apple's
    // notifications move the status. Neither may cost the user access.
    const f = facts({ subscription: activeSub({ status: 'active', autoRenew: false }) });
    expect(verdictOf(f)).toEqual({
      state: 'cancelled_in_period',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('someone who cancels on day 3 of an annual plan still has 362 days', () => {
    const f = facts({
      subscription: activeSub({
        status: 'cancelled',
        autoRenew: false,
        currentPeriodEnd: new Date(NOW.getTime() + 362 * DAY_MS),
      }),
    });
    expect(resolveAccountState(f).entitled).toBe(true);
  });

  it('but once the paid period actually ends, they expire', () => {
    const f = facts({
      subscription: activeSub({
        status: 'cancelled',
        autoRenew: false,
        currentPeriodEnd: new Date(NOW.getTime() - MINUTE_MS),
      }),
    });
    expect(verdictOf(f)).toEqual({
      state: 'expired',
      entitled: false,
      canViewExistingTrips: true,
      blockReason: 'subscription_over',
    });
  });
});

describe('the clock outranks a stale status', () => {
  it('an "active" row whose period has passed is expired', () => {
    // A missing DID_RENEW webhook must not buy free access for as long as it
    // stays missing. The period end is the authority, the status is a cache.
    const f = facts({
      subscription: activeSub({
        status: 'active',
        currentPeriodEnd: new Date(NOW.getTime() - DAY_MS),
      }),
    });
    expect(verdictOf(f)).toEqual({
      state: 'expired',
      entitled: false,
      canViewExistingTrips: true,
      blockReason: 'subscription_over',
    });
  });

  it('expires exactly at currentPeriodEnd — again >=, not >', () => {
    const f = facts({ subscription: activeSub({ currentPeriodEnd: NOW }) });
    expect(resolveAccountState(f).state).toBe('expired');
    const oneMsEarlier = facts({
      subscription: activeSub({ currentPeriodEnd: new Date(NOW.getTime() + 1) }),
    });
    expect(resolveAccountState(oneMsEarlier).state).toBe('subscribed');
  });

  it('a null currentPeriodEnd means no end date, not an expired one', () => {
    // Admin grants and lifetime promos store null here. Reading null as
    // "period ended" would revoke exactly the accounts we gave away forever.
    const f = facts({ subscription: activeSub({ currentPeriodEnd: null }) });
    expect(verdictOf(f)).toEqual({
      state: 'subscribed',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('a null currentPeriodEnd does not rescue a refunded row', () => {
    const f = facts({ subscription: activeSub({ status: 'refunded', currentPeriodEnd: null }) });
    expect(resolveAccountState(f).state).toBe('refunded');
  });
});

describe('comped beats everything', () => {
  it('beats spend far over the stop threshold', () => {
    // The author's account and the CI fixtures spend more than any customer.
    // Capping them would red the pipeline over revenue they never generate.
    const f = facts({ comped: true, anthropicMicrocents12mo: STOP_MICROCENTS * 10 });
    expect(verdictOf(f)).toEqual({
      state: 'comped',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('beats a refunded subscription row', () => {
    const f = facts({ comped: true, subscription: activeSub({ status: 'refunded' }) });
    expect(verdictOf(f)).toEqual({
      state: 'comped',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('beats an expired trial on an ancient account', () => {
    const f = facts({ comped: true, createdAt: agedBy(400 * DAY_MS) });
    expect(resolveAccountState(f).state).toBe('comped');
  });

  it('still reports the crossed thresholds so the alert layer can see them', () => {
    const f = facts({ comped: true, anthropicMicrocents12mo: STOP_MICROCENTS });
    const v = resolveAccountState(f);
    expect(v.crossedWatch).toBe(true);
    expect(v.crossedStop).toBe(true);
  });
});

describe('cap thresholds', () => {
  it('one microcent under the watch line is plain subscribed', () => {
    const f = facts({
      subscription: activeSub(),
      anthropicMicrocents12mo: WATCH_MICROCENTS - 1,
    });
    const v = resolveAccountState(f);
    expect(v.state).toBe('subscribed');
    expect(v.crossedWatch).toBe(false);
  });

  it('exactly at WATCH_MICROCENTS is subscribed_watch', () => {
    const f = facts({ subscription: activeSub(), anthropicMicrocents12mo: WATCH_MICROCENTS });
    const v = resolveAccountState(f);
    expect(v.state).toBe('subscribed_watch');
    expect(v.crossedWatch).toBe(true);
    expect(v.crossedStop).toBe(false);
  });

  it('subscribed_watch is entitled and invisible to the user', () => {
    // The user sees nothing at this threshold; only we get an email. So the
    // verdict must be indistinguishable from `subscribed` in every field the
    // UI reads — the state name is for the alert layer alone.
    const f = facts({ subscription: activeSub(), anthropicMicrocents12mo: WATCH_MICROCENTS });
    expect(verdictOf(f)).toEqual({
      state: 'subscribed_watch',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
  });

  it('one microcent under the stop line is still subscribed_watch', () => {
    const f = facts({
      subscription: activeSub(),
      anthropicMicrocents12mo: STOP_MICROCENTS - 1,
    });
    const v = resolveAccountState(f);
    expect(v.state).toBe('subscribed_watch');
    expect(v.crossedStop).toBe(false);
  });

  it('exactly at STOP_MICROCENTS is subscribed_capped', () => {
    const f = facts({ subscription: activeSub(), anthropicMicrocents12mo: STOP_MICROCENTS });
    const v = resolveAccountState(f);
    expect(v.state).toBe('subscribed_capped');
    expect(v.crossedStop).toBe(true);
  });
});

describe('canViewExistingTrips', () => {
  it('is false only for refunded and revoked', () => {
    // Blocking a sale is not the same as closing an account. Every other
    // blocked state still lets the driver read the trip they are ON.
    const cases: Array<[AccountState, AccountFacts]> = [
      ['trial', facts()],
      ['trial_spent', facts({ anthropicMicrocents12mo: TRIAL_CEILING_MICROCENTS })],
      ['trial_expired', facts({ createdAt: agedBy(30 * DAY_MS) })],
      ['subscribed', facts({ subscription: activeSub() })],
      [
        'subscribed_watch',
        facts({ subscription: activeSub(), anthropicMicrocents12mo: WATCH_MICROCENTS }),
      ],
      [
        'subscribed_capped',
        facts({ subscription: activeSub(), anthropicMicrocents12mo: STOP_MICROCENTS }),
      ],
      ['cancelled_in_period', facts({ subscription: activeSub({ status: 'cancelled' }) })],
      ['expired', facts({ subscription: activeSub({ status: 'expired' }) })],
      ['billing_grace', facts({ subscription: activeSub({ status: 'grace' }) })],
      ['comped', facts({ comped: true })],
    ];

    for (const [expectedState, f] of cases) {
      const v = resolveAccountState(f);
      expect(v.state).toBe(expectedState);
      expect(v.canViewExistingTrips).toBe(true);
    }

    for (const status of ['refunded', 'revoked'] as const) {
      const v = resolveAccountState(facts({ subscription: activeSub({ status }) }));
      expect(v.state).toBe(status);
      expect(v.canViewExistingTrips).toBe(false);
      expect(v.blockReason).toBe('revoked');
    }
  });
});

describe('trialDaysRemaining', () => {
  it('is the full trial on a brand-new account', () => {
    expect(trialDaysRemaining(NOW, NOW)).toBe(TRIAL_DAYS);
  });

  it('rounds up — a part-day left is still a day of trial to show', () => {
    // Copy says "1 day left", never "0 days left" while access still works.
    expect(trialDaysRemaining(NOW, agedBy(6 * DAY_MS + 23 * HOUR_MS))).toBe(1);
    expect(trialDaysRemaining(NOW, agedBy(TRIAL_DAYS * DAY_MS - MINUTE_MS))).toBe(1);
  });

  it('is exact when the remainder lands on a whole day', () => {
    expect(trialDaysRemaining(NOW, agedBy(3 * DAY_MS))).toBe(4);
  });

  it('floors at 0 rather than going negative', () => {
    expect(trialDaysRemaining(NOW, agedBy(TRIAL_DAYS * DAY_MS))).toBe(0);
    expect(trialDaysRemaining(NOW, agedBy(400 * DAY_MS))).toBe(0);
  });
});

describe('trialEndsAt', () => {
  it('is created_at plus TRIAL_DAYS', () => {
    const createdAt = new Date('2026-08-01T09:30:00.000Z');
    expect(trialEndsAt(createdAt).getTime()).toBe(createdAt.getTime() + TRIAL_DAYS * DAY_MS);
  });
});
