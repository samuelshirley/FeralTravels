import { describe, expect, it } from 'vitest';
import {
  annualSavingsNote,
  manageSubscriptionAvailable,
  planLength,
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
  title: 'Feral Travels monthly',
  priceLabel: '$2.69',
  cadence: 'per month',
  period: 'month',
};
const ANNUAL: PaywallProduct = {
  id: 'com.feraltravels.ios.annual',
  title: 'Feral Travels annual',
  priceLabel: '$22.00',
  cadence: 'per year',
  period: 'year',
};
const SERVER = [MONTHLY, ANNUAL];

/** One storefront's two products, as `getStorePlans()` returns them. */
function storefront(
  currencyCode: string,
  monthly: [number, string],
  annual: [number, string],
  titles: [string, string] = ['Feral Travels monthly', 'Feral Travels annual'],
  annualPerMonth: string | null = null
): StoreAnswer {
  const plans: StorePlanLike[] = [
    {
      productId: ANNUAL.id,
      title: titles[1],
      price: annual[0],
      priceLabel: annual[1],
      currencyCode,
      pricePerMonthLabel: annualPerMonth,
    },
    {
      productId: MONTHLY.id,
      title: titles[0],
      price: monthly[0],
      priceLabel: monthly[1],
      currencyCode,
      pricePerMonthLabel: monthly[1],
    },
  ];
  return { kind: 'packages', plans };
}

// The three storefronts as priced in App Store Connect, 2026-09, with
// RevenueCat's `pricePerMonthString` for the annual product.
const US = storefront('USD', [2.69, '$2.69'], [22, '$22.00'], undefined, '$1.83');
const EUROPE = storefront('EUR', [2, '2,00 €'], [20, '20,00 €'], undefined, '1,67 €');
const CANADA = storefront('CAD', [3, '$3.00'], [30, '$30.00'], undefined, '$2.50');

const STORE_BOTH = EUROPE;

function resolve(storeAnswer: StoreAnswer, serverPlans = SERVER, locale = 'en-US') {
  return resolvePurchaseMode({ storeAnswer, serverPlans, locale });
}

/** A single store plan, for the tests that need only one. */
function only(productId: string): StoreAnswer {
  return {
    kind: 'packages',
    plans: [
      {
        productId,
        title: 'Feral Travels monthly',
        priceLabel: '$2.69',
        price: 2.69,
        currencyCode: 'USD',
        pricePerMonthLabel: '$2.69',
      },
    ],
  };
}

/** Every store answer that cannot sell — each must render no row and no price. */
const FAILURES: StoreAnswer[] = [
  { kind: 'pending' },
  { kind: 'no_key' },
  { kind: 'error' },
  { kind: 'packages', plans: [] },
  only('com.feraltravels.app.monthly'),
];

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
    expect(r.plans).toEqual([]);
  });

  it('no_key: the build never configured the SDK', () => {
    const r = resolve({ kind: 'no_key' });
    expect(r.mode).toBe('unavailable');
    expect(r.unavailableReason).toBe('no_key');
    expect(r.plans).toEqual([]);
  });

  it('store_error: the offerings call threw', () => {
    const r = resolve({ kind: 'error' });
    expect(r.unavailableReason).toBe('store_error');
    expect(r.plans).toEqual([]);
  });

  it('store_empty: RevenueCat answered with no packages (the agreement / metadata case)', () => {
    const r = resolve({ kind: 'packages', plans: [] });
    expect(r.mode).toBe('unavailable');
    expect(r.unavailableReason).toBe('store_empty');
    expect(r.plans).toEqual([]);
  });

  it('no_match: packages came back and none is a plan the server sells', () => {
    const r = resolve(only('com.feraltravels.app.monthly'));
    expect(r.mode).toBe('unavailable');
    expect(r.unavailableReason).toBe('no_match');
    // No rows: the server's fallback prices are never shown.
    expect(r.plans).toEqual([]);
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

describe('the subscription title (Guideline 3.1.2(c))', () => {
  /**
   * App Review rejected 1.0 (12) on 2026-10-19 because the purchase sheet named
   * no subscription: each row was a price and a cadence under the APP's name.
   * Every row must carry the auto-renewing subscription's own title, in every
   * mode, because every mode renders rows.
   */
  it("store: each row carries the STORE's title — App Store Connect's localized display name", () => {
    const r = resolve(storefront('EUR', [2, '2,00 €'], [20, '20,00 €'], ['Feral Travels mensual', 'Feral Travels anual']));
    expect(r.mode).toBe('store');
    expect(r.plans.map((p) => p.title)).toEqual(['Feral Travels mensual', 'Feral Travels anual']);
  });

  it("store: a blank store title falls back to the server's, never to an untitled row", () => {
    const r = resolve(storefront('USD', [2.69, '$2.69'], [22, '$22.00'], ['', '   ']));
    expect(r.plans.map((p) => p.title)).toEqual(['Feral Travels monthly', 'Feral Travels annual']);
  });

  it('every row the store mode renders is titled — and no other mode renders rows', () => {
    for (const answer of [US, EUROPE, CANADA, only(MONTHLY.id)]) {
      const r = resolve(answer);
      expect(r.mode).toBe('store');
      expect(r.plans.length).toBeGreaterThan(0);
      for (const p of r.plans) expect(p.title.trim(), p.id).not.toBe('');
    }
    for (const answer of FAILURES) expect(resolve(answer).plans, answer.kind).toEqual([]);
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

  it('Europe: €2 × 12 − €20 is €4, without decimals, written the way the store writes €20', () => {
    // The store's label is "20,00 €", so the saving is "4 €" — whatever the
    // device is set to. The badge sits beside that price and must read like it.
    for (const device of ['en-IE', 'en-US', 'de-DE', 'es-ES']) {
      expect(note(resolve(EUROPE, SERVER, device)), device).toBe('Save 4\u00a0€ a year');
    }
  });

  it('Canada: CA$3 × 12 − CA$30 is $6, the way the Canadian storefront writes its own prices', () => {
    expect(note(resolve(CANADA, SERVER, 'en-US'))).toBe('Save $6 a year');
    expect(note(resolve(CANADA, SERVER, 'en-CA'))).toBe('Save $6 a year');
  });

  it("follows the STOREFRONT, not the device: a US storefront on a Spanish phone is '$10.28'", () => {
    // Seen on a real iPhone 2026-10-20: "$22.00 per year" beside
    // "Save 10,28 US$ a year" — the price in the storefront's format, the
    // saving in the device's (es-ES).
    expect(note(resolve(US, SERVER, 'es-ES'))).toBe('Save $10.28 a year');
    expect(note(resolve(US, SERVER, 'de-DE'))).toBe('Save $10.28 a year');
  });

  it("a storefront format we cannot reproduce gets no badge rather than a guessed one", () => {
    const odd = storefront('USD', [2.69, 'USD 2.69'], [22, 'USD ~22~']);
    expect(note(resolve(odd, SERVER, 'en-US'))).toBeUndefined();
  });

  it('only on the annual plan', () => {
    expect(resolve(US).plans.find((p) => p.id === MONTHLY.id)?.note).toBeUndefined();
  });

  it('no badge in unavailable mode — there are no rows to carry one', () => {
    // Even a payload that still carries a server-authored note (an older
    // server) must not put a figure on the sheet the store has not given us.
    const stale = [MONTHLY, { ...ANNUAL, note: 'Save $4 a year' }];
    for (const answer of FAILURES) {
      const r = resolve(answer, stale);
      expect(r.mode, answer.kind).toBe('unavailable');
      expect(JSON.stringify(r), answer.kind).not.toContain('Save');
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
    const usd = (price: number) => ({ price, currencyCode: 'USD', priceLabel: `$${price.toFixed(2)}` });
    // Two currencies cannot be subtracted.
    expect(annualSavingsNote(usd(2.69), { price: 20, currencyCode: 'EUR', priceLabel: '20,00 €' })).toBeUndefined();
    // An annual plan that saves nothing, or costs more, is not a saving.
    expect(annualSavingsNote(usd(2), usd(24))).toBeUndefined();
    expect(annualSavingsNote(usd(2), usd(30))).toBeUndefined();
    expect(annualSavingsNote(usd(Number.NaN), usd(22))).toBeUndefined();
    expect(annualSavingsNote(usd(2.69), { price: 22, currencyCode: '', priceLabel: '$22.00' })).toBeUndefined();
  });

  it('float noise cannot turn a whole saving into cents, or cents into a whole', () => {
    // 0.1 × 12 is 1.2000000000000002 in floating point.
    expect(annualSavingsNote({ price: 0.1, currencyCode: 'USD' }, { price: 0.2, currencyCode: 'USD', priceLabel: '$0.20' }, 'en-US')).toBe('Save $1 a year');
    expect(annualSavingsNote({ price: 2.99, currencyCode: 'USD' }, { price: 29.99, currencyCode: 'USD', priceLabel: '$29.99' }, 'en-US')).toBe('Save $5.89 a year');
  });

  it('a zero-decimal currency comes out without decimals', () => {
    expect(annualSavingsNote({ price: 400, currencyCode: 'JPY' }, { price: 4000, currencyCode: 'JPY', priceLabel: '￥4,000' }, 'ja-JP')).toBe('Save ￥800 a year');
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

describe('no price the store did not supply (Guideline 3.1.2 — 2026-10-20)', () => {
  /**
   * Unavailable mode used to render the server's `fallbackUsdLabel` ("$2.69",
   * "$22.00") with no renewal terms: a US price in front of every storefront,
   * beside nothing Apple requires with it. Now no row, and no price string of
   * any kind, can come out of a resolution the store did not price.
   */
  const FALLBACK_LABELS = SERVER.map((p) => p.priceLabel);

  it('no failure mode carries a row, a price string or a server fallback label', () => {
    const answers: StoreAnswer[] = [...FAILURES, { kind: 'packages', plans: [] }];
    for (const answer of answers) {
      for (const serverPlans of [SERVER, []]) {
        const r = resolve(answer, serverPlans);
        expect(r.mode, answer.kind).toBe('unavailable');
        expect(r.plans, answer.kind).toEqual([]);
        const json = JSON.stringify(r);
        for (const label of FALLBACK_LABELS) expect(json, answer.kind).not.toContain(label);
        expect(json, answer.kind).not.toMatch(/[$€£]|\d[.,]\d\d/);
      }
    }
  });

  it("store mode's price is ALWAYS the store's string, never the server's", () => {
    // A storefront whose prices happen to differ from the fallbacks in every
    // character, so a leaked fallback cannot hide.
    const r = resolve(storefront('GBP', [1.99, '£1.99'], [19.99, '£19.99'], undefined, '£1.67'));
    expect(r.plans.map((p) => p.priceLabel)).toEqual(['£1.99', '£19.99']);
    expect(JSON.stringify(r)).not.toContain('$');
  });

  it('a package with a blank price string is not rendered — and none priced means store_empty', () => {
    const blankAnnual = storefront('USD', [2.69, '$2.69'], [22, '  '], undefined, '$1.83');
    const r = resolve(blankAnnual);
    expect(r.mode).toBe('store');
    expect(r.plans.map((p) => p.id)).toEqual([MONTHLY.id]);

    const allBlank = storefront('USD', [2.69, ''], [22, ''], undefined, '$1.83');
    const none = resolve(allBlank);
    expect(none.mode).toBe('unavailable');
    expect(none.unavailableReason).toBe('store_empty');
    expect(none.plans).toEqual([]);
  });
});

describe('length and per-month price on every row (Guideline 3.1.2(c))', () => {
  it('says each plan\'s length outright', () => {
    const r = resolve(US);
    expect(r.plans.map((p) => p.length)).toEqual(['1 month', '1 year']);
    expect(planLength('month')).toBe('1 month');
    expect(planLength('year')).toBe('1 year');
  });

  it("the annual row carries the store's per-month price, billed annually", () => {
    const annual = (a: StoreAnswer) => resolve(a).plans.find((p) => p.period === 'year');
    expect(annual(US)?.perMonth).toBe('$1.83/month, billed annually');
    expect(annual(EUROPE)?.perMonth).toBe('1,67 €/month, billed annually');
    expect(annual(CANADA)?.perMonth).toBe('$2.50/month, billed annually');
  });

  it('the monthly row has no per-month line — its price already is one', () => {
    expect(resolve(US).plans.find((p) => p.period === 'month')?.perMonth).toBeUndefined();
  });

  it('no per-month line when the store gave no figure — never one we computed', () => {
    const noFigure = storefront('USD', [2.69, '$2.69'], [22, '$22.00'], undefined, null);
    expect(resolve(noFigure).plans.find((p) => p.period === 'year')?.perMonth).toBeUndefined();
    const blank = storefront('USD', [2.69, '$2.69'], [22, '$22.00'], undefined, ' ');
    expect(resolve(blank).plans.find((p) => p.period === 'year')?.perMonth).toBeUndefined();
  });
});

