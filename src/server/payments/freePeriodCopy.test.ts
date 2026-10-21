import { describe, expect, it } from 'vitest';
import { TRIAL_DAYS } from './constants';
import { FREE_PERIOD } from '@/lib/planStatusLine';
import { planningCaption } from '@/lib/planningCaption';

/**
 * The client copy names the free period's length ("Free for your first 7
 * days") but is a mirrored file that cannot import this module's constants.
 * This pins the two together, inside the bounded module, so changing
 * `TRIAL_DAYS` without rewording the copy fails here.
 */
describe('free-period copy matches TRIAL_DAYS', () => {
  it('the Settings status line names the real number of days', () => {
    expect(FREE_PERIOD).toContain(`first ${TRIAL_DAYS} days`);
  });

  it("Penny's planning caption counts down from the real number", () => {
    expect(planningCaption({ state: 'trial', trialDaysRemaining: TRIAL_DAYS })).toMatch(/free day/);
  });
});
