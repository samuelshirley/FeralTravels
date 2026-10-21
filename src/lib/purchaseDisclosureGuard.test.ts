/**
 * Full subscription disclosure on the purchase sheet, in every mode, and a
 * sheet that fits the window App Review actually used.
 *
 * The incident: 1.0 (12) was rejected under Guideline 3.1.2(c) on 2026-10-19,
 * and the follow-up audit (2026-10-20) found the rest of the same checklist
 * thin. The renewal sentence rendered only in `store` mode; the Terms and
 * Privacy links were 11.5pt subtle grey labelled "Terms" and "Privacy"; rows
 * gave a cadence but never a length or the annual plan's per-month price; and
 * unavailable mode printed the server's US fallback prices with no terms at
 * all. Review ran on an iPad Air 11" in iPhone compatibility mode — a shorter
 * window than any iPhone the sheet was drawn on.
 *
 * `purchaseMode.test.ts` holds the DATA half (no row without a store price,
 * length and per-month on every row). This holds the RENDER half, from source
 * text — mobile/ has no React Native test runner.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SHEET = readFileSync(path.join(ROOT, 'mobile/components/PurchaseSheet.tsx'), 'utf8');

/** The body of a top-level `function Name(...) {...}`, by brace matching. */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`function ${name}\\(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', src.indexOf('}:', start) > 0 ? src.indexOf('}:', start) : start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`function ${name} is unterminated`);
}

/** Leading spaces of the line holding `needle` — its JSX nesting depth. */
function indentOf(src: string, needle: string): number {
  const at = src.indexOf(needle);
  if (at < 0) throw new Error(`${needle} not found`);
  const lineStart = src.lastIndexOf('\n', at) + 1;
  return at - lineStart;
}

describe('the purchase sheet discloses everything, in every mode (Guideline 3.1.2(c))', () => {
  it('carries the renewal terms verbatim', () => {
    expect(SHEET).toContain(
      '"Payment is charged to your Apple Account at confirmation of purchase. Subscriptions renew " +\n' +
        '  "automatically unless cancelled at least 24 hours before the end of the current period. " +\n' +
        '  "Manage or cancel in your Apple Account settings."'
    );
  });

  it('renders the renewal terms UNCONDITIONALLY — a sibling of Restore, not inside a mode branch', () => {
    // Inside `{mode === "store" ? (...) : null}` the element is indented two
    // levels deeper than the always-rendered Restore row. Same depth = same
    // parent = rendered whenever the sheet is.
    expect(SHEET).toMatch(
      /<Text testID="purchase-renewal-terms"[^>]*>\s*\{AUTO_RENEW_DISCLOSURE\}\s*<\/Text>/
    );
    expect(indentOf(SHEET, '<Text testID="purchase-renewal-terms"')).toBe(
      indentOf(SHEET, '<View style={styles.secondaryRow}>')
    );
  });

  it('links the Terms of Use (EULA) and the Privacy Policy, by their full names, to the legal pages', () => {
    expect(SHEET).toMatch(/<LegalLink[^>]*label="Terms of Use \(EULA\)"[^>]*path="\/terms"/);
    expect(SHEET).toMatch(/<LegalLink[^>]*label="Privacy Policy"[^>]*path="\/privacy"/);
    expect(indentOf(SHEET, '<View style={styles.legalRow}>')).toBe(
      indentOf(SHEET, '<View style={styles.secondaryRow}>')
    );
  });

  it('makes the links visible: primary colour, underlined, at least 13pt', () => {
    const style = SHEET.match(/legalLink: \{([^}]*)\}/)?.[1] ?? '';
    expect(style).toContain('color: theme.primary');
    expect(style).toContain('textDecorationLine: "underline"');
    const size = Number(style.match(/fontSize: ([\d.]+)/)?.[1]);
    expect(size).toBeGreaterThanOrEqual(13);
    // The renewal sentence is body text, not a footnote.
    const renewal = SHEET.match(/renewalNote: \{([^}]*)\}/)?.[1] ?? '';
    expect(renewal).not.toContain('theme.subtle');
    expect(Number(renewal.match(/fontSize: ([\d.]+)/)?.[1])).toBeGreaterThanOrEqual(12.5);
  });

  it('a legal link that will not open says so, with the address — never swallowed', () => {
    const link = SHEET.slice(SHEET.indexOf('function LegalLink('), SHEET.indexOf('function PlanRow('));
    expect(link).not.toMatch(/\.catch\(\(\) => \{\s*\}\)/);
    expect(link).toMatch(/\.catch\(\(\) =>\s*onError\(`Couldn't open \$\{label\}\. It's at \$\{url\}`\)/);
    expect(SHEET).toMatch(/\{linkError \? \(\s*<Text testID="purchase-link-error"/);
  });

  it('keeps Restore in every mode and Manage only where there is something to manage', () => {
    expect(SHEET).toMatch(/<View style=\{styles\.secondaryRow\}>\s*<Pressable\s+testID="restore-purchases"/);
    expect(SHEET).toMatch(/\{manageSubscriptionAvailable \? \(\s*<Pressable\s+testID="manage-subscription"/);
  });

  it('each plan row shows title, price, cadence, length and the per-month line', () => {
    const row = functionBody(SHEET, 'PlanRow');
    expect(row).toMatch(/\{product\.title\}/);
    expect(row).toMatch(/\{product\.priceLabel\}/);
    expect(row).toMatch(/\{product\.cadence\}/);
    expect(row).toMatch(/product\.length/);
    expect(row).toMatch(/product\.perMonth/);
    expect(row).toMatch(/testID=\{`plan-length-\$\{product\.period\}`\}/);
  });

  it('renders plan rows ONLY in store mode', () => {
    // The rows are typed `SheetPlan`, which only the store branch of
    // `resolvePurchaseMode` builds; the sheet gates on the mode as well, so a
    // future widening of the type still cannot put a row on an unavailable sheet.
    expect(SHEET).toMatch(/\) : mode === "store" \? \(\s*<View style=\{styles\.plans\}>\s*\{plans\.map/);
    expect(SHEET).toMatch(/product: SheetPlan;/);
    expect(SHEET).not.toMatch(/PaywallProduct/);
  });

  it('nothing in the app can render the server fallback price', () => {
    // `fallbackUsdLabel` is a server constant; the payload's `priceLabel` is it.
    // Only `resolvePurchaseMode` reads `entitlement.products`, and it copies no
    // price from them.
    const flow = readFileSync(path.join(ROOT, 'mobile/lib/purchaseFlow.ts'), 'utf8');
    expect(flow).toMatch(/plans: readonly SheetPlan\[\]/);
    const mode = readFileSync(path.join(ROOT, 'src/lib/purchaseMode.ts'), 'utf8');
    const merge = mode.slice(mode.indexOf('const merged: SheetPlan[]'), mode.indexOf('if (merged.length === 0)'));
    expect(merge).toContain('priceLabel: store.priceLabel');
    expect(merge).not.toMatch(/\.\.\.p\b|p\.priceLabel/);
  });
});

describe('the sheet fits a short window (iPad, iPhone compatibility mode)', () => {
  it('everything under the header scrolls, in a ScrollView that shrinks to the sheet', () => {
    expect(SHEET).toMatch(/scroll: \{[^}]*flexGrow: 0[^}]*flexShrink: 1[^}]*\}/);
    expect(SHEET).toMatch(/sheet: \{[^}]*maxHeight: "85%"/);
    const scrollStart = SHEET.indexOf('<ScrollView');
    const scrollEnd = SHEET.indexOf('</ScrollView>');
    const inside = SHEET.slice(scrollStart, scrollEnd);
    for (const id of ['purchase-renewal-terms', 'restore-purchases', 'purchase-terms-link', 'purchase-privacy-link']) {
      expect(inside, id).toContain(id);
    }
  });

  it('no style in the sheet has a fixed height that could clip content', () => {
    const styles = SHEET.slice(SHEET.indexOf('const styles = StyleSheet.create'));
    // The grabber pill (4pt) is the one fixed height, and it holds no content.
    const heights = [...styles.matchAll(/\n {2}(\w+): \{[^}]*?\bheight: \d+/g)].map((m) => m[1]);
    expect(heights).toEqual(['grabber']);
  });
});
