/**
 * The no-trips paywall screen (`mobile/app/paywall.tsx`) has a way out in every
 * state.
 *
 * The incident (audit 2026-10-20, Guidelines 5.1.1(v) and 2.1): for a blocked
 * account with no trips this screen IS the app, and it had no route to
 * Settings — so no sign-out and no account deletion — its failure copy said
 * "Pull to reload" with no RefreshControl behind it, and when the entitlement
 * fetch failed the CTA did nothing (the sheet needed a payload to open).
 *
 * Source text: mobile/ has no React Native test runner. paywall-no-trips.yaml
 * drives the same three things on a simulator.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SCREEN = readFileSync(path.join(ROOT, 'mobile/app/paywall.tsx'), 'utf8');

describe('paywall screen: no dead ends', () => {
  it('links to Account settings, outside the loading/message branch, so it shows in every state', () => {
    expect(SCREEN).toMatch(
      /testID="paywall-account-settings"[\s\S]{0,120}onPress=\{\(\) => router\.push\("\/settings"\)\}[\s\S]{0,200}Account settings/
    );
    // A direct child of the ScrollView: after the conditional message closes,
    // before the ScrollView does.
    const afterBranch = SCREEN.slice(SCREEN.indexOf('        )}\n'), SCREEN.indexOf('</ScrollView>'));
    expect(afterBranch).toContain('paywall-account-settings');
  });

  it('pull-to-refresh is real: a RefreshControl that reloads the entitlement', () => {
    expect(SCREEN).toMatch(/refreshControl=\{\s*<RefreshControl[\s\S]{0,200}onRefresh=\{\(\) => void refresh\(\)\}/);
    expect(SCREEN).toMatch(/const refresh = useCallback\(async \(\) => \{[\s\S]{0,120}await load\(\)/);
  });

  it('a failed load turns the CTA into "Try again", which reloads', () => {
    expect(SCREEN).toMatch(/const failed = !loading && entitlement === null;/);
    expect(SCREEN).toMatch(/if \(failed\) \{\s*void refresh\(\);\s*return;\s*\}/);
    expect(SCREEN).toMatch(/failed\s*\?\s*"Try again"/);
  });

  it('the failure copy names only ways to retry that exist', () => {
    const copy = SCREEN.slice(SCREEN.indexOf('function fallbackMessage'));
    expect(copy).toMatch(/Pull down or tap Try again/);
  });
});
