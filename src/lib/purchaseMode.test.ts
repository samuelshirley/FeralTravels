import { describe, expect, it } from 'vitest';
import {
  manageSubscriptionAvailable,
  resolvePurchaseMode,
  unavailableMessage,
  type StoreAnswer,
  type UnavailableReason,
} from './purchaseMode';
import type { PaywallProduct } from '@/types/entitlement';

const MONTHLY: PaywallProduct = {
  id: 'com.feraltravels.ios.monthly',
  priceLabel: '$2',
  cadence: 'per month',
};
const ANNUAL: PaywallProduct = {
  id: 'com.feraltravels.ios.annual',
  priceLabel: '$20',
  cadence: 'per year',
  note: 'Save $4 a year',
};
const SERVER = [MONTHLY, ANNUAL];

const STORE_BOTH: StoreAnswer = {
  kind: 'packages',
  plans: [
    { productId: ANNUAL.id, priceLabel: '€19,99' },
    { productId: MONTHLY.id, priceLabel: '€2,49' },
  ],
};

function resolve(storeAnswer: StoreAnswer, serverPlans = SERVER, testMode = false) {
  return resolvePurchaseMode({ testMode, storeAnswer, serverPlans });
}

describe('resolvePurchaseMode', () => {
  it('store: both plans match, in the SERVER order with the STORE prices', () => {
    const r = resolve(STORE_BOTH);
    expect(r.mode).toBe('store');
    expect(r.unavailableReason).toBeNull();
    expect(r.plansLoading).toBe(false);
    expect(r.plans.map((p) => p.id)).toEqual([MONTHLY.id, ANNUAL.id]);
    expect(r.plans.map((p) => p.priceLabel)).toEqual(['€2,49', '€19,99']);
    // Server-authored copy survives the merge.
    expect(r.plans[1].note).toBe('Save $4 a year');
    expect(r.plans[0].cadence).toBe('per month');
  });

  it('store: ONE plan matching is left as one plan — the asymmetry is the diagnostic', () => {
    const r = resolve({
      kind: 'packages',
      plans: [{ productId: MONTHLY.id, priceLabel: '$2.00' }],
    });
    expect(r.mode).toBe('store');
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0].id).toBe(MONTHLY.id);
  });

  it('test mode wins over a store that would have sold, and never asks the store', () => {
    const r = resolve(STORE_BOTH, SERVER, true);
    expect(r.mode).toBe('test');
    // Fallback prices, not the store's: the store was not consulted.
    expect(r.plans.map((p) => p.priceLabel)).toEqual(['$2', '$20']);
    expect(r.plansLoading).toBe(false);
  });

  it('test mode wins even while the store would still be pending', () => {
    const r = resolve({ kind: 'pending' }, SERVER, true);
    expect(r.mode).toBe('test');
    expect(r.plansLoading).toBe(false);
  });

  it('pending: not sellable yet, loading, no reason (nothing has gone wrong)', () => {
    const r = resolve({ kind: 'pending' });
    expect(r.mode).toBe('unavailable');
    expect(r.unavailableReason).toBeNull();
    expect(r.plansLoading).toBe(true);
    expect(r.plans).toEqual(SERVER);
  });

  it('no_key: the build never configured the SDK', () => {
    const r = resolve({ kind: 'no_key' });
    expect(r.mode).toBe('unavailable');
    expect(r.unavailableReason).toBe('no_key');
    expect(r.plans).toEqual(SERVER);
  });

  it('store_error: the offerings call threw', () => {
    const r = resolve({ kind: 'error' });
    expect(r.unavailableReason).toBe('store_error');
    expect(r.plans).toEqual(SERVER);
  });

  it('store_empty: RevenueCat answered with no packages (the agreement / metadata case)', () => {
    const r = resolve({ kind: 'packages', plans: [] });
    expect(r.mode).toBe('unavailable');
    expect(r.unavailableReason).toBe('store_empty');
    expect(r.plans).toEqual(SERVER);
  });

  it('no_match: packages came back and none is a plan the server sells', () => {
    const r = resolve({
      kind: 'packages',
      plans: [{ productId: 'com.feraltravels.app.monthly', priceLabel: '$2.00' }],
    });
    expect(r.mode).toBe('unavailable');
    expect(r.unavailableReason).toBe('no_match');
    // The server's rows still render, with the fallback prices.
    expect(r.plans).toEqual(SERVER);
  });

  it('no_plans: the server gave nothing to sell, whatever the store said', () => {
    expect(resolve(STORE_BOTH, []).unavailableReason).toBe('no_plans');
    expect(resolve({ kind: 'packages', plans: [] }, []).unavailableReason).toBe('no_plans');
    expect(resolve(STORE_BOTH, []).plans).toEqual([]);
  });

  it('no_key and store_error are reported before the server list is consulted', () => {
    // These two say the STORE is unreachable, which is true regardless of what
    // the server would have sold — so an empty server list does not mask them.
    expect(resolve({ kind: 'no_key' }, []).unavailableReason).toBe('no_key');
    expect(resolve({ kind: 'error' }, []).unavailableReason).toBe('store_error');
  });
});

describe('unavailableMessage', () => {
  const REASONS: UnavailableReason[] = [
    'no_key',
    'store_empty',
    'store_error',
    'no_match',
    'no_plans',
  ];

  it('has one sentence per reason, sharing no string', () => {
    const messages = REASONS.map(unavailableMessage);
    expect(new Set(messages).size).toBe(REASONS.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(40);
  });

  it('every reason but no_key points a payer at Restore', () => {
    for (const reason of REASONS) {
      const m = unavailableMessage(reason);
      if (reason === 'no_key') {
        // The SDK was never configured, so `restore()` refuses too. Promising
        // it would work is a lie to exactly the person who paid.
        expect(m).not.toMatch(/Restore purchases/);
        expect(m).toMatch(/restored/);
      } else {
        expect(m).toMatch(/Restore purchases/);
      }
    }
  });

  it('every reason says these are prices and not a checkout, or that nothing can be bought', () => {
    for (const reason of REASONS) {
      expect(unavailableMessage(reason)).toMatch(/not a checkout|can be bought|reopen/);
    }
  });
});

describe('manageSubscriptionAvailable', () => {
  it('hides the link when the entitlement is unknown', () => {
    expect(manageSubscriptionAvailable(null)).toBe(false);
  });

  it('hides it for a trial and shows it once the same account has bought', () => {
    expect(manageSubscriptionAvailable({ state: 'trial', source: null })).toBe(false);
    expect(manageSubscriptionAvailable({ state: 'subscribed', source: 'apple_iap' })).toBe(true);
  });

  it('hides it for a promo row — nothing exists at Apple to manage', () => {
    expect(manageSubscriptionAvailable({ state: 'subscribed', source: 'promo' })).toBe(false);
  });
});
