/**
 * The review sign-in decision itself, at the boundary the two `otp.ts` branches
 * ask it.
 *
 * `src/lib/reviewAccountGuard.test.ts` is the structural half — that the
 * address and code are literals, that nothing else consults them, that the
 * account is neither admin nor comped. This is the behavioural half: the
 * decision function, tested the way the call sites use it.
 *
 * Both branches in `otp.ts` are gated on `isReviewAccountSignIn(normalized)`,
 * where `normalized` is already `trim().toLowerCase()`. So the cases that
 * matter are: armed or not, and this address or a near-miss.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  REVIEW_ACCOUNT_CODE,
  REVIEW_ACCOUNT_EMAIL,
  isReviewAccountEmail,
  isReviewAccountSignIn,
  isReviewSignInArmed,
} from './reviewAccount';

const ARMED = { APPLE_REVIEW_SIGNIN: '1' };
const OFF = {};

describe('isReviewSignInArmed', () => {
  it('is armed only by exactly "1"', () => {
    expect(isReviewSignInArmed({ APPLE_REVIEW_SIGNIN: '1' })).toBe(true);
    expect(isReviewSignInArmed({ APPLE_REVIEW_SIGNIN: '0' })).toBe(false);
    expect(isReviewSignInArmed({ APPLE_REVIEW_SIGNIN: 'true' })).toBe(false);
    expect(isReviewSignInArmed({ APPLE_REVIEW_SIGNIN: undefined })).toBe(false);
    expect(isReviewSignInArmed(OFF)).toBe(false);
  });
});

describe('what sendOtpCode asks', () => {
  // `if (isReviewAccountSignIn(normalized))` — skip the ladder, skip Resend,
  // store the fixed code.
  it('says no for every address while the flag is off', () => {
    expect(isReviewAccountSignIn(REVIEW_ACCOUNT_EMAIL, OFF)).toBe(false);
    expect(isReviewAccountSignIn('someone@example.com', OFF)).toBe(false);
  });

  it('says yes only for the review address while armed', () => {
    expect(isReviewAccountSignIn(REVIEW_ACCOUNT_EMAIL, ARMED)).toBe(true);
    expect(isReviewAccountSignIn('someone@example.com', ARMED)).toBe(false);
  });
});

describe('what verifyOtpCode asks', () => {
  // `if (isReviewAccountSignIn(normalized) && submitted === REVIEW_ACCOUNT_CODE)`
  const accepts = (email: string, submitted: string, env: Record<string, string>) =>
    isReviewAccountSignIn(email, env) && submitted === REVIEW_ACCOUNT_CODE;

  it('accepts the fixed code for the review address when armed', () => {
    expect(accepts(REVIEW_ACCOUNT_EMAIL, '000000', ARMED)).toBe(true);
  });

  it('rejects the fixed code when the flag is off', () => {
    // The whole point of the switch: with it unset this is just a wrong code.
    expect(accepts(REVIEW_ACCOUNT_EMAIL, '000000', OFF as Record<string, string>)).toBe(false);
  });

  it('rejects the fixed code for every other address, armed or not', () => {
    for (const email of [
      'someone@example.com',
      'appletest@gmail.com',
      'appletest@feraltravels.com.evil.com',
      'sam@feraltravels.com',
    ]) {
      expect(accepts(email, '000000', ARMED), email).toBe(false);
      expect(accepts(email, '000000', OFF as Record<string, string>), email).toBe(false);
    }
  });

  it('rejects any other code for the review address, even when armed', () => {
    // Only this one code short-circuits; anything else falls through to the
    // real stored-row check below it in verifyOtpCode.
    for (const code of ['000001', '00000', '0000000', '123456', '', ' 000000 ']) {
      expect(accepts(REVIEW_ACCOUNT_EMAIL, code, ARMED), code).toBe(false);
    }
  });
});

describe('address normalisation matches the rest of the auth surface', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(isReviewAccountEmail('  APPLETEST@FeralTravels.COM ')).toBe(true);
  });

  it('is an exact match, not a substring one', () => {
    expect(isReviewAccountEmail('appletest@feraltravels.com.evil.com')).toBe(false);
    expect(isReviewAccountEmail('notappletest@feraltravels.com')).toBe(false);
  });

  it('handles null and undefined without throwing', () => {
    expect(isReviewAccountEmail(null)).toBe(false);
    expect(isReviewAccountEmail(undefined)).toBe(false);
    expect(isReviewAccountSignIn(null, ARMED)).toBe(false);
  });
});
