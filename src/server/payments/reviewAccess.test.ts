import { describe, expect, it } from 'vitest';
import { applyReviewAccess } from './reviewAccess';
import { resolveAccountState } from './states';

/**
 * App Review's demo account is entitled in every state while armed, with its
 * state untouched — the pure half. The DB half (the email lookup, the flag, no
 * row written) is src/test/pg/payments.test.ts.
 */
const NOW = new Date('2026-10-20T12:00:00Z');
const day = 24 * 60 * 60 * 1000;

function verdictFor(sub: Parameters<typeof resolveAccountState>[0]['subscription'], ageDays = 30) {
  return resolveAccountState({
    now: NOW,
    createdAt: new Date(NOW.getTime() - ageDays * day),
    comped: false,
    anthropicMicrocents12mo: 0,
    subscription: sub,
  });
}

const row = (status: 'expired' | 'refunded' | 'revoked') => ({
  status,
  currentPeriodEnd: new Date(NOW.getTime() - day),
  autoRenew: false,
  productId: 'com.feraltravels.ios.monthly',
  source: 'apple_iap' as const,
});

describe('applyReviewAccess', () => {
  it('a review account past its free period is entitled, and its state still says what it is', () => {
    const before = verdictFor(null);
    expect(before).toMatchObject({ state: 'trial_expired', entitled: false, blockReason: 'trial_over' });
    const after = applyReviewAccess(before, true);
    expect(after).toMatchObject({
      state: 'trial_expired',
      entitled: true,
      canViewExistingTrips: true,
      blockReason: null,
    });
    // No subscription is invented: the display passthroughs are the row's (none).
    expect(after).toMatchObject({ source: null, productId: null, currentPeriodEnd: null });
  });

  it('entitles it in every blocked state — a sandbox refund must not lock a reviewer out', () => {
    for (const status of ['expired', 'refunded', 'revoked'] as const) {
      const after = applyReviewAccess(verdictFor(row(status)), true);
      expect(after.entitled, status).toBe(true);
      expect(after.canViewExistingTrips, status).toBe(true);
      expect(after.blockReason, status).toBeNull();
    }
  });

  it('changes nothing for any other account', () => {
    const before = verdictFor(null);
    expect(applyReviewAccess(before, false)).toBe(before);
  });
});
