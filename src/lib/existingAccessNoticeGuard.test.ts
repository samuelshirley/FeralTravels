/**
 * The purchase sheet tells an account that already has access what buying a
 * plan would mean for it.
 *
 * The decision (Sam, 2026-10-22): an Ambassador (promo) or comped account keeps
 * "View plans" — App Review's demo account is on a promo and must be able to
 * find and buy the subscriptions (Guideline 2.1) — but the sheet must say,
 * above the plans, that a plan bought now starts billing today. Without it a
 * promo user could pay for access they already had.
 *
 * `existingAccessNotice` decides the words (planStatusLine.test.ts). This holds
 * the wiring, which no unit test can see because `mobile/` has no test runner:
 *
 *  1. `usePurchaseFlow` hands the sheet `existingAccess`, computed by
 *     `existingAccessNotice` from the entitlement INCLUDING its `source` —
 *     without `source` a promo is indistinguishable from a purchase.
 *  2. `PurchaseSheet` renders it, as text, with the id the Maestro flow reads.
 *
 * Read as TEXT, never imported — `noMobileImportGuard.test.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('existing-access notice on the purchase sheet', () => {
  it('usePurchaseFlow computes it from the entitlement, source included', () => {
    const src = read('mobile/lib/purchaseFlow.ts');
    const call = src.match(/existingAccess:\s*entitlement\s*\?\s*existingAccessNotice\(\s*\{([\s\S]*?)\}/);
    expect(call, 'existingAccess must be existingAccessNotice({...}) of the entitlement').not.toBeNull();
    expect(call![1]).toMatch(/source:\s*entitlement\.source/);
    expect(call![1]).toMatch(/state:\s*entitlement\.state/);
    expect(call![1]).toMatch(/currentPeriodEnd:\s*entitlement\.currentPeriodEnd/);
  });

  it('PurchaseSheet renders it, above the plans, with the id Maestro reads', () => {
    const src = read('mobile/components/PurchaseSheet.tsx');
    const notice = src.search(/<Text testID="sheet-existing-access"[^>]*>\s*\{existingAccess\}\s*<\/Text>/);
    expect(notice, 'the notice is rendered as text with testID sheet-existing-access').toBeGreaterThan(-1);
    const plans = src.indexOf('{plansLoading ?');
    expect(plans).toBeGreaterThan(-1);
    expect(notice, 'the notice comes before the plan rows').toBeLessThan(plans);
  });
});
