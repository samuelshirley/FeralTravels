import { describe, expect, it } from 'vitest';
import {
  annualSavingsNote,
  manageSubscriptionAvailable,
  resolvePurchaseMode,
  unavailableMessage,
  type StoreAnswer,
  type StorePlanLike,
  type UnavailableReason,
} from './purchaseMode';
import type { PaywallProduct } from '@/types/entitlement';

/** What `/api/me/entitlement` sends: the US fallbacks, and no saving. */
const MONTHLY: PaywallProduct = {
  id: 'com.feraltravels.ios.monthly',
  priceLabel: '$2.69',
  cadence: 'per month',
  period: 'month',
};
const ANNUAL: PaywallProduct = {
  id: 'com.feraltravels.ios.annual',
  priceLabel: '$22.00',
  cadence: 'per year',
  period: 'year',
};
const SERVER = [MONTHLY, ANNUAL];

/** One storefront's two products, as `getStorePlans()` returns them. */
function storefront(
  currencyCode: string,
  monthly: [number, string],
  annual: [number, string]
): StoreAnswer {
  const plans: StorePlanLike[] = [
    { productId: ANNUAL.id, price: annual[0], priceLabel: annual[1], currencyCode },
    { productId: MONTHLY.id, price: monthly[0], priceLabel: monthly[1], currencyCode },
  ];
  return { kind: 'packages', plans };
}

// The three storefronts as priced in App Store Connect, 2026-09.
const US = storefront('USD', [2.69, '$2.69'], [22, '$22.00']);
const EUROPE = storefront('EUR', [2, '2,00 €'], [20, '20,00 €']);
const CANADA = storefront('CAD', [3, '$3.00'], [30, '$30.00']);

const STORE_BOTH = EUROPE;

function resolve(storeAnswer: StoreAnswer, serverPlans = SERVER, locale = 'en-US') {
  return resolvePurchaseMode({ storeAnswer, serverPlans, locale });
}

/** A single store plan, for the tests that need only one. */
function only(productId: string): StoreAnswer {
  return {
    kind: 'packages',
    plans: [{ productId, priceLabel: '$2.69', price: 2.69, currencyCode: 'USD' }],
  };
}

describe('resolvePurchaseMode', () => {
  it('store: both plans match, in the SERVER order with the STORE prices', () => {
    const r = resolve(STORE_BOTH);
    expect(r.mode).toBe('store');
    expect(r.unavailableReason).toBeNull();
    expect(r.plansLoading).toBe(false);
    expect(r.plans.map((p) => p.id)).toEqual([MONTHLY.id, ANNUAL.id]);
    expect(r.plans.map((p) => p.priceLabel)).toEqual(['2,00 €', '20,00 €']);
    // Server-authored copy survives the merge.
    expect(r.plans[0].cadence).toBe('per month');
  });

  it('store: ONE plan matching is left as one plan — the asymmetry is the diagnostic', () => {
    const r = resolve(only(MONTHLY.id));
    expect(r.mode).toBe('store');
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0].id).toBe(MONTHLY.id);
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
    const r = resolve(only('com.feraltravels.app.monthly'));
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

describe('the annual saving', () => {
  /**
   * Computed from the STORE's two numbers, never from constants.ts: a price
   * changed in App Store Connect must change this line with no code change.
   * The badge used to be a server string, "Save $4 a year", derived from the US
   * fallbacks, and it contradicted the store prices printed beside it.
   */
  const note = (r: ReturnType<typeof resolve>) => r.plans.find((p) => p.id === ANNUAL.id)?.note;

  it('US: $2.69 × 12 − $22.00 is $10.28 — the one that is not a whole number', () => {
    expect(note(resolve(US))).toBe('Save $10.28 a year');
  });

  it('Europe: €2 × 12 − €20 is €4, without decimals', () => {
    expect(note(resolve(EUROPE, SERVER, 'en-IE'))).toBe('Save €4 a year');
    // The sign's position is the reader's locale, not ours.
    expect(note(resolve(EUROPE, SERVER, 'de-DE'))).toBe('Save 4\u00a0€ a year');
  });

  it('Canada: CA$3 × 12 − CA$30 is CA$6, written the way the reader writes it', () => {
    // A US-English device must tell CAD from USD; a Canadian one calls it "$".
    expect(note(resolve(CANADA, SERVER, 'en-US'))).toBe('Save CA$6 a year');
    expect(note(resolve(CANADA, SERVER, 'en-CA'))).toBe('Save $6 a year');
  });

  it('only on the annual plan', () => {
    expect(resolve(US).plans.find((p) => p.id === MONTHLY.id)?.note).toBeUndefined();
  });

  it('no badge in unavailable mode — the fallbacks are no basis for arithmetic', () => {
    // Even a payload that still carries a server-authored note (an older
    // server) must not put a figure on the sheet the store has not given us.
    const stale = [MONTHLY, { ...ANNUAL, note: 'Save $4 a year' }];
    const answers: StoreAnswer[] = [
      { kind: 'pending' },
      { kind: 'no_key' },
      { kind: 'error' },
      { kind: 'packages', plans: [] },
      only('com.feraltravels.app.monthly'),
    ];
    for (const answer of answers) {
      const r = resolve(answer, stale);
      expect(r.mode, answer.kind).toBe('unavailable');
      expect(r.plans.map((p) => p.note), answer.kind).toEqual([undefined, undefined]);
      // The fallback prices themselves still render.
      expect(r.plans.map((p) => p.priceLabel)).toEqual(['$2.69', '$22.00']);
    }
  });

  it('no badge when only one of the two plans came back from the store', () => {
    expect(note(resolve(only(ANNUAL.id)))).toBeUndefined();
  });

  it('a stale server note never survives the store merge either', () => {
    const r = resolve(US, [MONTHLY, { ...ANNUAL, note: 'Save $4 a year' }]);
    expect(note(r)).toBe('Save $10.28 a year');
  });

  it('refuses when there is no honest figure', () => {
    const usd = (price: number) => ({ price, currencyCode: 'USD' });
    // Two currencies cannot be subtracted.
    expect(annualSavingsNote(usd(2.69), { price: 20, currencyCode: 'EUR' })).toBeUndefined();
    // An annual plan that saves nothing, or costs more, is not a saving.
    expect(annualSavingsNote(usd(2), usd(24))).toBeUndefined();
    expect(annualSavingsNote(usd(2), usd(30))).toBeUndefined();
    expect(annualSavingsNote(usd(Number.NaN), usd(22))).toBeUndefined();
    expect(annualSavingsNote(usd(2.69), { price: 22, currencyCode: '' })).toBeUndefined();
  });

  it('float noise cannot turn a whole saving into cents, or cents into a whole', () => {
    // 0.1 × 12 is 1.2000000000000002 in floating point.
    expect(annualSavingsNote({ price: 0.1, currencyCode: 'USD' }, { price: 0.2, currencyCode: 'USD' }, 'en-US')).toBe('Save $1 a year');
    expect(annualSavingsNote({ price: 2.99, currencyCode: 'USD' }, { price: 29.99, currencyCode: 'USD' }, 'en-US')).toBe('Save $5.89 a year');
  });

  it('a zero-decimal currency comes out without decimals', () => {
    expect(annualSavingsNote({ price: 400, currencyCode: 'JPY' }, { price: 4000, currencyCode: 'JPY' }, 'ja-JP')).toBe('Save ￥800 a year');
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

  it('says something substantive for every reason', () => {
    for (const reason of REASONS) expect(unavailableMessage(reason).length).toBeGreaterThan(40);
  });

  it('gives our own configuration failures ONE line, so the customer is not handed our diagnosis', () => {
    // store_empty and no_match differ only in which of OUR dashboards is
    // wrong. The five-way split is purchaseDiagnostics.ts, for dev builds.
    expect(unavailableMessage('store_empty')).toBe(unavailableMessage('no_match'));
  });

  it('tells the reader to retry only when retrying can help', () => {
    expect(unavailableMessage('store_error')).toMatch(/Try again/);
    expect(unavailableMessage('no_plans')).toMatch(/reopen/);
    expect(unavailableMessage('store_empty')).not.toMatch(/try again|reopen/i);
  });

  it('every reason but no_key points a payer at Restore', () => {
    for (const reason of REASONS) {
      const m = unavailableMessage(reason);
      if (reason === 'no_key') {
        // The SDK was never configured, so `restore()` refuses too. Promising
        // it would work is a lie to exactly the person who paid.
        expect(m).not.toMatch(/Restore/);
        expect(m).toMatch(/support@feraltravels\.com/);
      } else {
        expect(m).toMatch(/Restore purchases/);
      }
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
