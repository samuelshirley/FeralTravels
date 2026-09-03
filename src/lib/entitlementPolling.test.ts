import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENT_POLL_BUDGET_MS,
  ENTITLEMENT_POLL_DELAYS_MS,
  ENTITLEMENT_POLL_STEADY_MS,
  nextEntitlementPoll,
} from './entitlementPolling';

/**
 * The give-up rule, tested by describing a moment rather than by waiting one.
 *
 * What is actually at stake: this loop runs between Apple taking the money and
 * our webhook granting access. A loop that gives up too early tells a paying
 * customer something is wrong; a loop with no give-up at all leaves them on a
 * spinner with no idea whether to buy again.
 */
describe('nextEntitlementPoll', () => {
  it('waits a short beat before the first poll, not five seconds', () => {
    // The common case resolves in about a second. A flat steady-state poll
    // would make every successful purchase feel four seconds slower for no
    // benefit at all.
    const first = nextEntitlementPoll(0, 0);
    expect(first.giveUp).toBe(false);
    expect(first.waitMs).toBeLessThan(1000);
  });

  it('lengthens the gap, then settles', () => {
    const waits = ENTITLEMENT_POLL_DELAYS_MS.map((_, i) => nextEntitlementPoll(i, 0).waitMs);
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i], `attempt ${i}`).toBeGreaterThanOrEqual(waits[i - 1]);
    }
    // Past the front-loaded schedule it is a steady beat, for as many attempts
    // as the budget allows.
    expect(nextEntitlementPoll(ENTITLEMENT_POLL_DELAYS_MS.length, 0).waitMs).toBe(
      ENTITLEMENT_POLL_STEADY_MS
    );
    expect(nextEntitlementPoll(999, 0).waitMs).toBe(ENTITLEMENT_POLL_STEADY_MS);
  });

  it('never returns a zero or negative wait while it is still polling', () => {
    // A zero wait is a busy loop against our own API on a phone.
    for (let attempt = 0; attempt < 40; attempt++) {
      const d = nextEntitlementPoll(attempt, 0);
      expect(d.giveUp).toBe(false);
      expect(d.waitMs, `attempt ${attempt}`).toBeGreaterThan(0);
    }
  });

  it('gives up once the budget is spent, and not before', () => {
    expect(nextEntitlementPoll(20, ENTITLEMENT_POLL_BUDGET_MS - 1).giveUp).toBe(false);
    expect(nextEntitlementPoll(20, ENTITLEMENT_POLL_BUDGET_MS).giveUp).toBe(true);
    expect(nextEntitlementPoll(20, ENTITLEMENT_POLL_BUDGET_MS * 10).giveUp).toBe(true);
  });

  it('gives up on elapsed time, not on a number of attempts', () => {
    /**
     * The distinction is load-bearing. Attempts are cheap and a request can
     * hang for the whole budget on a bad connection — a count-based limit would
     * then give up after ten seconds of wall clock on one phone and ninety on
     * another. The user experiences seconds, so seconds are what is bounded.
     */
    expect(nextEntitlementPoll(1000, 0).giveUp).toBe(false);
    expect(nextEntitlementPoll(0, ENTITLEMENT_POLL_BUDGET_MS).giveUp).toBe(true);
  });

  it('spends the whole budget on the schedule rather than most of it', () => {
    // Walk the schedule the way the hook does and check it neither exits early
    // nor drags on: a budget the schedule can never reach would be a give-up
    // that never fires.
    let elapsed = 0;
    let attempt = 0;
    while (!nextEntitlementPoll(attempt, elapsed).giveUp && attempt < 1000) {
      elapsed += nextEntitlementPoll(attempt, elapsed).waitMs;
      attempt += 1;
    }
    expect(attempt).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(ENTITLEMENT_POLL_BUDGET_MS);
    // And it does not overshoot by more than one steady interval.
    expect(elapsed).toBeLessThan(ENTITLEMENT_POLL_BUDGET_MS + ENTITLEMENT_POLL_STEADY_MS);
  });
});
