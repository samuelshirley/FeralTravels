import { describe, expect, it } from 'vitest';
import { planStatusLine } from './planStatusLine';
import type { AccountState } from '@/types/entitlement';

/**
 * The twelve states, each asserted once. The value of this file is not the
 * strings — it is that adding a state to `AccountState` without deciding what
 * Settings says about it fails here as well as in `tsc`.
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

describe('planStatusLine', () => {
  it('counts the trial down in whole days', () => {
    expect(planStatusLine('trial', 7)).toBe('Free trial — 7 days left');
    expect(planStatusLine('trial', 2)).toBe('Free trial — 2 days left');
  });

  it('says "today" for the last day rather than "1 day left"', () => {
    // `daysUntil` in the entitlement route rounds UP and floors at 0, so 1 is
    // any part of a day and 0 only happens in the moment the state flips.
    // Neither is a full day; promising one would be a lie the user can catch.
    expect(planStatusLine('trial', 1)).toBe('Free trial — ends today');
    expect(planStatusLine('trial', 0)).toBe('Free trial — ends today');
  });

  it('never renders a bare number for a non-trial state', () => {
    // `trialDaysRemaining` is 0 for every state past the trial. A template that
    // leaked it would read "Subscribed — 0 days left".
    for (const state of ALL_STATES.filter((s) => s !== 'trial')) {
      expect(planStatusLine(state, 0)).not.toMatch(/\d/);
    }
  });

  it('reads subscribed_watch exactly like subscribed', () => {
    // It is an admin alert threshold. A user seeing anything different would be
    // reading about our costs, which is not their business and not actionable.
    expect(planStatusLine('subscribed_watch', 0)).toBe(planStatusLine('subscribed', 0));
  });

  it('does not tell a lapsed trial WHY it lapsed', () => {
    // trial_spent is the $1 Anthropic ceiling and trial_expired is day seven.
    // The difference matters to us and to nobody else; surfacing it invites an
    // argument about a number the user cannot see.
    expect(planStatusLine('trial_spent', 0)).toBe(planStatusLine('trial_expired', 0));
  });

  it('keeps access-still-live states reading as subscribed', () => {
    // The failure this guards: someone inside the period they paid for reading
    // "cancelled" and concluding the app has already stopped working.
    for (const state of ['cancelled_in_period', 'billing_grace'] as AccountState[]) {
      expect(planStatusLine(state, 0)).toMatch(/^Subscribed/);
    }
  });

  it('gives every state a non-empty line', () => {
    for (const state of ALL_STATES) {
      const line = planStatusLine(state, 3);
      expect(line.length, state).toBeGreaterThan(0);
      expect(line, state).not.toContain('undefined');
    }
  });
});
