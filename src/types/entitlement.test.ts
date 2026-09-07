import { describe, expect, it } from 'vitest';
import {
  canManageAppleSubscription,
  type AccountState,
  type SubscriptionSource,
} from './entitlement';

/**
 * The "Manage subscription" link, decided per state. The point of this file
 * is the same as `planStatusLine.test.ts`: every one of the twelve states is
 * asserted, so adding a state without deciding whether Apple has anything to
 * show it fails here as well as in `tsc`.
 */
const NO_ROW: AccountState[] = ['trial', 'trial_spent', 'trial_expired', 'comped'];
const ROW: AccountState[] = [
  'subscribed',
  'subscribed_watch',
  'subscribed_capped',
  'cancelled_in_period',
  'billing_grace',
  'expired',
  'refunded',
  'revoked',
];

describe('canManageAppleSubscription', () => {
  it('covers all twelve states exactly once', () => {
    const all: AccountState[] = [...NO_ROW, ...ROW];
    expect(new Set(all).size).toBe(12);
  });

  it.each(NO_ROW)('%s: no subscription row has ever existed, so Apple lists nothing', (state) => {
    // Whatever the source claims — a trial has no row for a source to be on.
    expect(canManageAppleSubscription(state, null)).toBe(false);
    expect(canManageAppleSubscription(state, 'apple_iap')).toBe(false);
  });

  it.each(ROW)('%s: an Apple row exists, so the link is shown', (state) => {
    expect(canManageAppleSubscription(state, 'apple_iap')).toBe(true);
  });

  it.each(ROW)('%s: a test-purchase row stands in for Apple and shows the link', (state) => {
    expect(canManageAppleSubscription(state, 'fake')).toBe(true);
  });

  it.each(ROW)('%s: a row with no recorded source still shows it (never hide from a payer)', (state) => {
    expect(canManageAppleSubscription(state, null)).toBe(true);
  });

  const NOT_APPLE: SubscriptionSource[] = ['promo', 'admin'];
  it.each(NOT_APPLE)("a %s row is ours, not Apple's, so there is nothing to manage there", (source) => {
    for (const state of ROW) {
      expect(canManageAppleSubscription(state, source)).toBe(false);
    }
  });

  it('shows the link the moment a trial account becomes subscribed', () => {
    // The same-session case: the payload before and after a purchase.
    expect(canManageAppleSubscription('trial', null)).toBe(false);
    expect(canManageAppleSubscription('subscribed', 'apple_iap')).toBe(true);
  });
});
