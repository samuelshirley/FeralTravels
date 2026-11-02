/**
 * No screen in the app uses the native stack's navigation bar. Every route
 * draws its own header.
 *
 * The incident: on an iPhone 16 Pro Max running iOS 27.0.1 (2026-10-22),
 * Settings' native back button rendered as an empty Liquid Glass pill: no
 * chevron, no "Back". The same JavaScript drew "‹ Back" correctly on the
 * iOS 26.5 simulators, so neither the simulator runs nor CI could have caught
 * it. react-native-screens 4.16 predates iOS 27, and the UIKit navigation bar
 * had already bitten once before: trips/index moved its account avatar out of
 * `headerRight` because iOS 26 wrapped it in a second glass circle.
 *
 * So the rule is structural: a header the app draws itself cannot be emptied
 * by a UIKit change. This holds it:
 *
 *  1. Every `<Stack.Screen>` declared in app/_layout.tsx has `headerShown: false`.
 *  2. Nothing under mobile/app turns a header back on (`headerShown: true`).
 *  3. Settings, the screen that used the native bar, renders its own back
 *     control with the id flows can tap.
 *
 * Read as TEXT, never imported — `noMobileImportGuard.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('no native navigation bar anywhere (iOS 27 empty back button)', () => {
  it('every route declared in app/_layout.tsx hides the native header', () => {
    const layout = read('mobile/app/_layout.tsx');
    const screens = [...layout.matchAll(/<Stack\.Screen\b([\s\S]*?)\/>/g)].map((m) => m[1]);
    expect(screens.length, 'found no <Stack.Screen> declarations').toBeGreaterThan(0);
    const shown = screens
      .filter((attrs) => !/headerShown:\s*false/.test(attrs))
      .map((attrs) => attrs.match(/name="([^"]+)"/)?.[1] ?? attrs.trim());
    expect(shown, 'these routes still draw the native navigation bar').toEqual([]);
  });

  it('nothing under mobile/app turns a native header back on', () => {
    const offenders = walk(path.join(ROOT, 'mobile/app'))
      .filter((f) => /headerShown:\s*true/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('Settings draws its own back control', () => {
    const src = read('mobile/app/settings.tsx');
    expect(src).toMatch(/testID="settings-back"/);
    expect(src).toMatch(/router\.canGoBack\(\)\s*\?\s*router\.back\(\)/);
    expect(src).toMatch(/<Text[^>]*>Back<\/Text>/);
  });
});
