/**
 * Every plan row a customer or App Review can see names the subscription it buys.
 *
 * The incident: App Review rejected 1.0 (12) on 2026-10-19 under Guideline
 * 3.1.2(c) — "the following information needs to be included within the app:
 * title of publication or service." The purchase sheet's rows were a price and
 * a cadence ("$2.69 per month") under a heading that named only the APP
 * ("Feral Travels / Choose a plan"). Length, price, the renewal sentence and
 * the Terms/Privacy links were all there; the subscription's own title was not,
 * because `PaywallProduct` had no field to carry it.
 *
 * The fix is structural, and this guard holds its parts:
 *
 *  1. `PaywallProduct.title` is REQUIRED (tsc holds that: no producer can omit
 *     it), and `resolvePurchaseMode` never lets a blank store title through
 *     (purchaseMode.test.ts holds that, in every mode).
 *  2. The store's title actually reaches the app: `getStorePlans` maps
 *     RevenueCat's `product.title`, App Store Connect's localized display name.
 *  3. The server's fallback titles exist and match the products' display names
 *     in the .storekit file, so a fallback row reads like a store row — held
 *     inside the payments module, src/server/payments/productTitles.test.ts,
 *     because nothing outside it may import its constants.
 *  4. Every native file that renders a plan's price renders its title too.
 *     Checked across all of mobile/, not just PurchaseSheet, so a second
 *     surface that lists plans cannot reintroduce the untitled row.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'ios' || name === 'android' || name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

/** The body of a top-level `function Name(...) {...}`, by brace matching. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`function ${name} is unterminated`);
}

describe('subscription title on every plan row (Guideline 3.1.2(c))', () => {
  it("PurchaseSheet's PlanRow renders the title beside the price and the cadence", () => {
    const body = functionBody(read('mobile/components/PurchaseSheet.tsx'), 'PlanRow');
    expect(body).toMatch(/<Text[^>]*>\s*\{product\.title\}\s*<\/Text>/);
    expect(body).toContain('{product.priceLabel}');
    expect(body).toContain('{product.cadence}');
    // VoiceOver reads the same three things a sighted reviewer does.
    expect(body).toMatch(/accessibilityLabel=\{`\$\{product\.title\}/);
  });

  it('every native file that renders a plan price also renders its title', () => {
    const offenders = walk(path.join(ROOT, 'mobile'))
      .filter((f) => /\{\s*\w+\.priceLabel\s*\}/.test(readFileSync(f, 'utf8')))
      .filter((f) => !/\{\s*\w+\.title\s*\}/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the store's localized display name reaches the app", () => {
    const src = read('mobile/lib/purchases.ts');
    expect(src).toMatch(/title:\s*p\.product\.title/);
  });
});
