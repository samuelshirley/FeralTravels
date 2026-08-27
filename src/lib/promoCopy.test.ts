import { describe, it, expect } from 'vitest';
import { PROMO_ERROR_COPY } from './promoCopy';
import type { PromoRefusal } from './promoCode';

/**
 * The same shape of guard as `paywallCopy.test.ts`.
 *
 * TypeScript already forces `PROMO_ERROR_COPY` to be exhaustive over
 * `PromoRefusal`, so this does not re-assert that. What it asserts is what a
 * type cannot: that the four messages are actually four DIFFERENT messages.
 * Nothing stops someone collapsing them to one "that code cannot be used"
 * string, the compiler would be perfectly happy, and three of the four failures
 * a person can act on would stop telling them how.
 */
const ALL: PromoRefusal[] = [
  'promo_not_found',
  'promo_already_redeemed',
  'promo_expired',
  'promo_wrong_account',
];

describe('PROMO_ERROR_COPY', () => {
  it('says something for every refusal the server can return', () => {
    for (const reason of ALL) {
      expect(PROMO_ERROR_COPY[reason]?.trim(), reason).toBeTruthy();
    }
  });

  it('shares no message between two refusals', () => {
    const messages = ALL.map((r) => PROMO_ERROR_COPY[r]);
    expect(new Set(messages).size).toBe(ALL.length);
  });

  it('names the fix in the wrong-account case rather than the suspicion', () => {
    /**
     * The one refusal likely to be read by somebody who did nothing wrong.
     * Sign in with Apple can hand us a private relay address instead of the one
     * the code was issued to, so the likeliest reader is confused, not devious.
     * The copy has to tell them what to do; "this code is not yours" alone is a
     * dead end and an accusation at the same time.
     */
    const copy = PROMO_ERROR_COPY.promo_wrong_account.toLowerCase();
    expect(copy).toContain('email address');
    expect(copy).toContain('sign in');
  });

  it('never accuses anybody of anything', () => {
    // Same rule the paywall copy is held to. A promo refusal is a support
    // moment, and every one of these words turns it into an argument.
    for (const reason of ALL) {
      const copy = PROMO_ERROR_COPY[reason].toLowerCase();
      for (const banned of ['invalid', 'illegal', 'fraud', 'stolen', 'not allowed', 'denied']) {
        expect(copy, `${reason} says "${banned}"`).not.toContain(banned);
      }
    }
  });
});
