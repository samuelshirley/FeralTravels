import { describe, it, expect } from 'vitest';
import {
  OTP_RESEND_LADDER_MS,
  OTP_THROTTLE_WINDOW_MS,
  cooldownForSendCount,
  retryAfterSeconds,
} from './otpThrottle';

/**
 * The shipped bug this replaces: a flat 60-second cooldown, discoverable only
 * by pressing a button the page actively invited you to press, reported in
 * copy that hard-coded "60 seconds" whether you had waited 0 or 59 of them.
 *
 * These tests pin the SHAPE of the ladder, not just its numbers — a limiter
 * that quietly becomes flat again, or that grows a rung that goes DOWN, is
 * the failure mode worth catching.
 */
describe('OTP resend ladder', () => {
  it('lets the first send through with no wait at all', () => {
    expect(cooldownForSendCount(0)).toBe(0);
  });

  it('keeps the first three sends cheap, for the user who really did not get it', () => {
    expect(cooldownForSendCount(1)).toBe(1_000);
    expect(cooldownForSendCount(2)).toBe(1_000);
    expect(cooldownForSendCount(3)).toBe(60_000);
  });

  it('escalates to the two-minute ceiling and stays there', () => {
    expect(cooldownForSendCount(4)).toBe(120_000);
    expect(cooldownForSendCount(5)).toBe(120_000);
    expect(cooldownForSendCount(50)).toBe(120_000);
    expect(cooldownForSendCount(5_000)).toBe(120_000);
  });

  it('never eases off as sends pile up', () => {
    // The property that matters more than any single rung: an address that
    // has asked for more codes must never face a SHORTER wait than one that
    // asked for fewer.
    for (let n = 1; n < 20; n++) {
      expect(cooldownForSendCount(n)).toBeGreaterThanOrEqual(cooldownForSendCount(n - 1));
    }
  });

  it('never lets the ceiling become effectively unlimited', () => {
    // A permanent lockout on an address ANYONE can type is itself the attack.
    const ceiling = OTP_RESEND_LADDER_MS[OTP_RESEND_LADDER_MS.length - 1];
    expect(ceiling).toBeLessThanOrEqual(OTP_THROTTLE_WINDOW_MS);
    expect(Number.isFinite(ceiling)).toBe(true);
  });

  it('resets the window later than the longest wait it can impose', () => {
    // Otherwise the ceiling would expire itself: an address could sit out the
    // window and drop back to rung one without ever waiting the two minutes.
    expect(OTP_THROTTLE_WINDOW_MS).toBeGreaterThan(
      OTP_RESEND_LADDER_MS[OTP_RESEND_LADDER_MS.length - 1]
    );
  });
});

describe('retryAfterSeconds', () => {
  it('rounds up, so the countdown never undershoots the server', () => {
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(59_400)).toBe(60);
  });

  it('never renders 0s next to a button that still refuses', () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(999)).toBe(1);
  });
});
