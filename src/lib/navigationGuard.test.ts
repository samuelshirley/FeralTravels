/**
 * Going "back" in the app returns to the screen that is already there. It
 * never builds a new one.
 *
 * The incident (screen recording, iPhone, 2026-10-22): "‹ Trips" called
 * `router.push("/trips")`. Expo Router's `push` always adds a screen, so the
 * trips list slid in FROM THE RIGHT as a brand-new instance, started empty,
 * and sat on a spinner while it refetched. Every list → trip → list round
 * trip added two screens to the stack. BottomNav on Settings did the same to
 * the trip workspace: LIST/MAP/CHAT pushed a second copy of the trip that was
 * already mounted underneath, which opened on "Loading trip" and a cold map.
 *
 * The rules, held structurally:
 *  1. Nothing in the app PUSHES the trips list. It is the app's root: it is
 *     returned to (`dismissTo`) or replaced into, never stacked.
 *  2. A trip tab reached from outside the trip pops back to it (`dismissTo`).
 *  3. Trip screens are keyed by trip id (`getId`), so that pop lands on the
 *     right trip and a trip already open is never stacked twice.
 *  4. The workspace applies a tab handed to it AFTER mount, then clears it.
 *
 * Read as TEXT, never imported (noMobileImportGuard.test.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'shared') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const SOURCES = ['mobile/app', 'mobile/components', 'mobile/lib'].flatMap((d) =>
  walk(path.join(ROOT, d))
);

describe('back means back (no screen is rebuilt to go back to it)', () => {
  it('finds the native sources', () => {
    expect(SOURCES.length).toBeGreaterThan(20);
  });

  it('nothing pushes the trips list', () => {
    const offenders = SOURCES.filter((f) =>
      /router\.(push|navigate)\(\s*["'`]\/trips["'`]\s*\)/.test(readFileSync(f, 'utf8'))
    ).map((f) => path.relative(ROOT, f));
    expect(offenders, 'use router.dismissTo("/trips")').toEqual([]);
  });

  it('nothing pushes a trip tab destination', () => {
    const offenders = SOURCES.filter((f) =>
      /router\.(push|navigate)\(\s*tripTabDestination\(/.test(readFileSync(f, 'utf8'))
    ).map((f) => path.relative(ROOT, f));
    expect(offenders, 'use router.dismissTo(tripTabDestination(...))').toEqual([]);
  });

  it('the trip header’s "‹ Trips" pops back to the list', () => {
    const src = read('mobile/components/TripHeader.tsx');
    expect(src).toMatch(/accessibilityLabel="Back to trips"/);
    expect(src).toMatch(/onPress=\{\(\) => router\.dismissTo\("\/trips"\)\}/);
  });

  it('the account menu’s "Trips" item pops back too (it routes through a variable the regex above cannot see)', () => {
    const src = read('mobile/components/TripHeader.tsx');
    const go = src.match(/const go = useCallback\(([\s\S]*?)\n  \);/)?.[1] ?? '';
    expect(go).toMatch(/if \(path === "\/trips"\) router\.dismissTo\("\/trips"\);/);
    expect(src).toMatch(/onPress=\{\(\) => go\("\/trips"\)\}/);
  });

  it('BottomNav pops back into the trip instead of stacking another', () => {
    expect(read('mobile/components/BottomNav.tsx')).toMatch(
      /router\.dismissTo\(tripTabDestination\(id, lastOpenTripId\(\)\)\)/
    );
  });

  it('trip screens are keyed by trip id', () => {
    const layout = read('mobile/app/_layout.tsx');
    const screen = layout.match(/<Stack\.Screen\s+name="trips\/\[tripId\]"([\s\S]*?)\/>\n/)?.[1] ?? '';
    expect(screen).toMatch(/getId=\{/);
    expect(screen).toMatch(/tripId/);
  });

  it('the workspace applies a tab requested after mount, then clears it', () => {
    const src = read('mobile/app/trips/[tripId].tsx');
    expect(src).toMatch(/if \(!requestedTab\) return;\s*setTab\(requestedTab\);\s*router\.setParams\(\{ tab: undefined \}\);/);
  });
});
