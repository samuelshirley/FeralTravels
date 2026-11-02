/**
 * After a purchase, the app waits for the server to RECORD the App Store
 * subscription — not merely for the account to be entitled.
 *
 * The incident (audit 2026-10-20, Guideline 2.1(b)): `purchaseFlow.ts` polled
 * `/api/me/entitlement` until `fresh?.entitled`. A trial account is entitled
 * before it buys anything, so the poll answered yes at once, before the
 * RevenueCat webhook: the sheet closed and Settings went on saying "Free
 * trial — 7 days left". To a reviewer that is a purchase that did nothing.
 *
 * The decision is the pure `appleSubscriptionConfirmed` (unit-tested in
 * purchaseMode.test.ts). This holds that the flow — the one place all four
 * purchase surfaces wait — actually uses it, for every path that waits, and
 * that Settings re-renders its status line from the confirmed payload.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const FLOW = readFileSync(path.join(ROOT, 'mobile/lib/purchaseFlow.ts'), 'utf8');

function block(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`${from} … ${to} not found`);
  return src.slice(a, b);
}

describe('post-purchase state (Guideline 2.1(b))', () => {
  const wait = block(FLOW, 'const waitForEntitlement = useCallback(', '}, [onEntitled]);');

  it('the wait stops on appleSubscriptionConfirmed, never on `entitled`', () => {
    expect(wait).toMatch(/appleSubscriptionConfirmed\(fresh\)/);
    expect(wait).not.toMatch(/\.entitled\b/);
  });

  it('there is ONE wait, and purchase, restore and offer code all go through it', () => {
    expect(FLOW.match(/await fetchEntitlement\(\)/g)).toHaveLength(1);
    const confirming = FLOW.match(/setPhase\(\{ kind: "confirming", cause: "(\w+)" \}\);\s*(?:\/\/[^\n]*\n\s*)*[\s\S]{0,400}?await waitForEntitlement\(\)/g) ?? [];
    const causes = confirming.map((m) => m.match(/cause: "(\w+)"/)?.[1]).sort();
    expect(causes).toEqual(['offer_code', 'purchase', 'restore']);
  });

  it('Settings stores the confirmed payload and builds its status line from it', () => {
    const section = readFileSync(path.join(ROOT, 'mobile/components/SubscriptionSection.tsx'), 'utf8');
    // Stored in the resource cache since 2026-10-22, so the card and every
    // other screen reading the verdict see the confirmed plan at once.
    expect(section).toMatch(/onEntitled: \(fresh\) => \{[\s\S]*?rememberEntitlement\(fresh\);[\s\S]*?\}/);
    expect(section).toMatch(/const entitlement = useEntitlement\(\);/);
    expect(section).toMatch(/planStatusLine\(\s*\{\s*state: entitlement\.state/);
  });
});
