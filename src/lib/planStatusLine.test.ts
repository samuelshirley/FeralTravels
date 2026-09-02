import { describe, expect, it } from 'vitest';
import { planStatusLine, type PlanStatus } from './planStatusLine';
import type { AccountState } from '@/types/entitlement';

/**
 * The twelve states, each asserted once. The value of this file is not the
 * strings — it is that adding a state to `AccountState` without deciding what
 * Settings says about it fails here as well as in `tsc`.
 *
 * Every case fixes `now`, the way `states.test.ts` does and for the same
 * reason: the only thing the clock decides here is whether a date carries its
 * year, and that boundary is untestable against the real calendar.
 */
const ALL_STATES: AccountState[] = [
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

const NOW = new Date('2026-09-02T12:00:00.000Z');
/** Same calendar year as NOW. */
const THIS_YEAR = '2026-10-03T12:00:00.000Z';
/** A year on — what an annual plan bought today actually renews. */
const NEXT_YEAR = '2027-09-03T12:00:00.000Z';

function status(overrides: Partial<PlanStatus> = {}): PlanStatus {
  return {
    state: 'subscribed',
    trialDaysRemaining: 0,
    trialEndsAt: null,
    plan: 'monthly',
    source: 'apple_iap',
    currentPeriodEnd: THIS_YEAR,
    autoRenew: true,
    ...overrides,
  };
}

const line = (o: Partial<PlanStatus> = {}) => planStatusLine(status(o), NOW);

describe('planStatusLine', () => {
  it('counts the trial down AND says the date it ends', () => {
    // Two different questions — "how long have I got" and "when do I decide
    // by" — and the card has room for both.
    expect(line({ state: 'trial', trialDaysRemaining: 5, trialEndsAt: '2026-09-09T00:00:00Z' })).toBe(
      'Free trial — 5 days left, ends 9 Sep'
    );
  });

  it('says "today" for the last day rather than "1 day left"', () => {
    // `daysUntil` in the entitlement route rounds UP and floors at 0, so 1 is
    // any part of a day and 0 only happens in the moment the state flips.
    // Neither is a full day; promising one would be a lie the user can catch.
    const trial = { state: 'trial' as const, trialEndsAt: '2026-09-03T00:00:00Z' };
    expect(line({ ...trial, trialDaysRemaining: 1 })).toBe('Free trial — ends today');
    expect(line({ ...trial, trialDaysRemaining: 0 })).toBe('Free trial — ends today');
  });

  it('falls back to the day count when the trial has no end date', () => {
    expect(line({ state: 'trial', trialDaysRemaining: 5, trialEndsAt: null })).toBe(
      'Free trial — 5 days left'
    );
  });

  it('names the plan and the renewal date', () => {
    expect(line({ plan: 'monthly' })).toBe('Monthly plan — renews 3 Oct');
    expect(line({ plan: 'annual', currentPeriodEnd: NEXT_YEAR })).toBe(
      'Annual plan — renews 3 Sep 2027'
    );
  });

  it('shows the year only when it is not the current one', () => {
    // "renews 3 Oct 2026" is noise eleven months of the year; "renews 3 Sep"
    // on an annual plan bought today is actively wrong.
    expect(line({ currentPeriodEnd: THIS_YEAR })).toContain('3 Oct');
    expect(line({ currentPeriodEnd: THIS_YEAR })).not.toContain('2026');
    expect(line({ currentPeriodEnd: NEXT_YEAR })).toContain('2027');
  });

  it('says a cancelled plan ENDS on a date, and leads with the date', () => {
    // Someone inside the period they paid for must not read this and conclude
    // the app has already stopped working. The date comes first for that
    // reason; the renewal fact is the tail.
    expect(line({ state: 'cancelled_in_period', autoRenew: false })).toBe(
      "Monthly plan — ends 3 Oct, won't renew"
    );
  });

  it('NEVER renders a null date at anybody', () => {
    /**
     * The specific failure: a comped or promo account is entitled with a
     * `subscriptions` row carrying no `currentPeriodEnd`, because null means
     * "no end" rather than "unknown". Every branch that wants a date has to be
     * able to drop it.
     */
    for (const state of ALL_STATES) {
      const l = planStatusLine(
        status({ state, currentPeriodEnd: null, trialEndsAt: null }),
        NOW
      );
      expect(l, state).not.toMatch(/null|undefined|NaN|Invalid/);
      expect(l.trim(), state).not.toMatch(/(renews|ends)$/);
    }
    expect(line({ state: 'subscribed', currentPeriodEnd: null })).toBe('Monthly plan');
  });

  it('survives an unparseable date rather than printing "Invalid Date"', () => {
    expect(line({ currentPeriodEnd: 'not-a-date' })).toBe('Monthly plan');
  });

  it('calls an entitled account with no product "Subscribed", not a made-up plan', () => {
    // An admin comp or a redeemed promo has no product id. "Monthly plan"
    // would be a plain lie about a row that says no such thing.
    expect(line({ plan: null })).toBe('Subscribed — renews 3 Oct');
  });

  it('calls a promo an Ambassador plan, and says it ENDS rather than renews', () => {
    /**
     * Two different grant paths that the UI used to conflate. A promo writes an
     * ordinary `subscriptions` row with `source: 'promo'` and NO product, so
     * without `source` the only honest label was "Subscribed" — and "renews"
     * would promise a recurrence that does not exist. Nothing renews a promo:
     * the term runs out and `periodOver` turns the row into `expired`.
     */
    expect(line({ source: 'promo', plan: null })).toBe('Ambassador plan — ends 3 Oct');
    expect(line({ source: 'promo', plan: null })).not.toContain('renews');
  });

  it('does NOT call an admin comp an Ambassador plan', () => {
    // `comped` is `users.comped`, a boolean checked before any subscription row
    // is read — a different grant path with no row, no source and no end date.
    // It must not borrow the promo's word or the purchase's.
    const comped = line({ state: 'comped', source: null, plan: null, currentPeriodEnd: null });
    expect(comped).toBe('On the house — no end date');
    expect(comped).not.toContain('Ambassador');
    expect(comped).not.toContain('Complimentary');
  });

  it('reads an EXPIRED promo as ended, not as an ambassador still on the plan', () => {
    /**
     * The property the whole fixed-term design rests on. `resolveAccountState`
     * turns an `active` row with a past `currentPeriodEnd` into `expired` — so
     * by the time this function sees it, the state is already `expired` and the
     * promo wording must be gone with it.
     */
    const ended = line({ state: 'expired', source: 'promo', plan: null, currentPeriodEnd: '2026-01-01T00:00:00Z' });
    expect(ended).toBe('Subscription ended');
    expect(ended).not.toContain('Ambassador');
  });

  it('reads subscribed_watch exactly like subscribed', () => {
    // It is an admin alert threshold. A user seeing anything different would be
    // reading about our costs, which is not their business and not actionable.
    expect(line({ state: 'subscribed_watch' })).toBe(line({ state: 'subscribed' }));
  });

  it('does not tell a lapsed trial WHY it lapsed', () => {
    // trial_spent is the $1 Anthropic ceiling and trial_expired is day seven.
    // The difference matters to us and to nobody else; surfacing it invites an
    // argument about a number the user cannot see.
    expect(line({ state: 'trial_spent' })).toBe(line({ state: 'trial_expired' }));
  });

  it('never leaks the trial day count into a non-trial state', () => {
    // A template that leaked it would read "Monthly plan — 0 days left".
    for (const state of ALL_STATES.filter((s) => s !== 'trial')) {
      expect(line({ state, trialDaysRemaining: 7 }), state).not.toContain('days left');
    }
  });

  it('keeps access-still-live states naming the plan rather than a failure', () => {
    for (const state of ['cancelled_in_period', 'billing_grace'] as AccountState[]) {
      expect(line({ state }), state).toMatch(/^Monthly plan/);
    }
  });

  it('gives every state a non-empty line', () => {
    for (const state of ALL_STATES) {
      const l = line({ state, trialDaysRemaining: 3, trialEndsAt: THIS_YEAR });
      expect(l.length, state).toBeGreaterThan(0);
      expect(l, state).not.toContain('undefined');
    }
  });
});
