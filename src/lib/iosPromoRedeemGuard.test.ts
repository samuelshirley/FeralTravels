/**
 * No iOS surface may unlock the paid tier with our own promo codes.
 *
 * The incident: the purchase sheet carried a "HAVE A CODE?" field
 * (FERAL-XXXX-XXXX → Redeem) that posted to `/api/promo/redeem` and switched
 * the paid tier on without in-app purchase. On iOS that is Guideline 3.1.1 —
 * digital access unlocked by a mechanism other than IAP — and Sam's decision
 * (2026-10-20) was to move to Apple's own offer codes, redeemed in StoreKit's
 * sheet, which arrive as App Store transactions through the same webhook as a
 * purchase.
 *
 * The server route and the admin tooling stay (the web uses them). What this
 * holds is the app side, structurally:
 *
 *  1. Nothing under mobile/ names the redeem endpoint or a client for it.
 *  2. The server's promo vocabulary is not mirrored into mobile/shared, so
 *     there is nothing to build a promo field from.
 *  3. The replacement exists and is Apple's: `Purchases.presentCodeRedemptionSheet`
 *     behind a "Redeem offer code" control on the purchase sheet.
 *
 * Source-text, like the other native guards: mobile/ has no test runner.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARED_FILES } from '../../scripts/sync-shared.mjs';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Every source, config and flow file the app is built or tested from. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'ios' || name === 'android' || name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?|mjs|cjs|json|ya?ml)$/.test(name)) out.push(full);
  }
  return out;
}

describe('iOS has no custom promo-code redemption (Guideline 3.1.1)', () => {
  const files = walk(path.join(ROOT, 'mobile'));

  it('walks a real tree', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('nothing under mobile/ calls or names the promo redeem endpoint', () => {
    const offenders = files
      .filter((f) => /\/api\/promo\/redeem|\bredeemPromoCode\b|\bPromoRedeemer\b/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('no mobile screen renders the old FERAL-XXXX-XXXX field', () => {
    const offenders = files
      .filter((f) => /\.tsx$/.test(f))
      .filter((f) => /testID=["']promo-(input|submit|redeemer)["']|PROMO_PLACEHOLDER/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the server promo modules are not mirrored into the app', () => {
    const dests = (SHARED_FILES as Array<[string, string]>).map(([, dest]) => dest);
    expect(dests.filter((d) => /promo/i.test(d))).toEqual([]);
    const shared = readdirSync(path.join(ROOT, 'mobile/shared/lib'));
    expect(shared.filter((f) => /promo/i.test(f))).toEqual([]);
  });

  it("the replacement is Apple's offer-code sheet, behind a control on the purchase sheet", () => {
    expect(read('mobile/lib/purchases.ts')).toMatch(/Purchases\.presentCodeRedemptionSheet\(\)/);
    const sheet = read('mobile/components/PurchaseSheet.tsx');
    expect(sheet).toMatch(
      /testID="redeem-offer-code"[\s\S]{0,200}onPress=\{flow\.redeemOfferCode\}[\s\S]{0,400}Redeem offer code/
    );
  });
});
