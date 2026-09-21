import { describe, expect, it } from 'vitest';
import { PLANNING_VIDEO_COPY, planningCaption } from './planningCaption';
import type { AccountState } from '@/types/entitlement';

describe('planningCaption', () => {
  it('tells a trial user how long they have left, in words', () => {
    expect(planningCaption({ state: 'trial', trialDaysRemaining: 7 })).toBe(
      'Building this trip now, you have seven more days on your free trial.',
    );
  });

  it('says "last day" rather than "one more days" on the final day', () => {
    expect(planningCaption({ state: 'trial', trialDaysRemaining: 1 })).toBe(
      "Building this trip now — it's the last day of your free trial.",
    );
  });

  it('falls back to the plain caption at zero days', () => {
    expect(planningCaption({ state: 'trial', trialDaysRemaining: 0 })).toBe(PLANNING_VIDEO_COPY);
  });

  it('never mentions a trial to an account that is not on one', () => {
    const notTrial: AccountState[] = ['subscribed', 'comped', 'trial_spent', 'trial_expired'];
    for (const state of notTrial) {
      // A non-zero count on a non-trial state must still not produce a trial line.
      expect(planningCaption({ state, trialDaysRemaining: 5 })).toBe(PLANNING_VIDEO_COPY);
    }
  });

  it('uses the plain caption when the entitlement could not be fetched', () => {
    expect(planningCaption(null)).toBe(PLANNING_VIDEO_COPY);
  });
});
