import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * No Expo Router route name may ever reach a header or a back button again.
 *
 * The bug this exists for: a native-stack header takes its title from the
 * screen's `title`, and the BACK button takes its label from the *previous*
 * screen's title. `trips/[tripId]` was declared `headerShown: false` and
 * nothing else, so react-navigation fell back to the route name — and the
 * Settings screen, pushed from a trip, rendered a back button reading
 * `trips/[tripId]`. Brackets, slash and all.
 *
 * It shipped because it is invisible in the place people look. Nothing types
 * it, nothing logs it, it is not in any component's source — it is the ABSENCE
 * of a title in a sibling declaration, rendered by a library. It was caught by
 * looking at an App Store screenshot.
 *
 * Read as TEXT, never imported — `noMobileImportGuard.test.ts` forbids `src/`
 * importing from `mobile/`, because CI's unit job runs `npm ci` at the root
 * only and `mobile/node_modules` does not exist there. Same approach as
 * `privacyManifest.test.ts`, and the same reason: `mobile/` has no test runner
 * of its own, so a guard on its shape lives here or nowhere.
 */
const LAYOUT = path.resolve(__dirname, '../../mobile/app/_layout.tsx');
const APP_DIR = path.resolve(__dirname, '../../mobile/app');
const source = fs.readFileSync(LAYOUT, 'utf8');

/**
 * Every `<Stack.Screen name="…" options={{ … }} />`, as (name, options-text).
 *
 * A regex over JSX rather than a parse. It is doing one narrow job on a file
 * whose shape is fixed and which this very test also pins the completeness of
 * — and if the regex ever stops matching, the route-coverage test below fails
 * loudly rather than passing on zero matches.
 */
function declaredScreens(): Array<{ name: string; options: string }> {
  const out: Array<{ name: string; options: string }> = [];
  const re = /<Stack\.Screen\s+name="([^"]+)"\s+options=\{\{([\s\S]*?)\}\}\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push({ name: m[1], options: m[2] });
  return out;
}

/**
 * The route names Expo Router will generate from the filesystem.
 *
 * `mobile/app/**\/*.tsx` minus `_layout`, with `index.tsx` inside a folder
 * becoming `folder/index` — which is how the layout already names them.
 */
function fileRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;
      const base = entry.name.replace(/\.tsx$/, '');
      if (base.startsWith('_')) continue;
      routes.push(`${prefix}${base}`);
    }
  };
  walk(APP_DIR, '');
  return routes.sort();
}

/** A label a human wrote, as opposed to a path a router generated. */
const ROUTEY = /[[\]/]/;

describe('mobile navigation labels', () => {
  const screens = declaredScreens();

  it('parses the Stack declarations at all', () => {
    // If the JSX shape changes and the regex stops matching, every other
    // assertion here would vacuously pass. This is the canary for that.
    expect(screens.length).toBeGreaterThan(4);
  });

  it('declares EVERY route the filesystem produces', () => {
    /**
     * The stronger half of the guard, and the one that would have caught
     * `paywall`: that route was declared nowhere, so it took the layout's
     * defaults, so it drew a native header titled "paywall" over a screen that
     * already draws its own. An undeclared route is a route with no answer.
     */
    const declared = new Set(screens.map((s) => s.name));
    const missing = fileRoutes().filter((r) => !declared.has(r));
    expect(missing, `undeclared route(s) in mobile/app/_layout.tsx: ${missing.join(', ')}`).toEqual(
      []
    );
  });

  it('gives every screen either a hidden header or a human title', () => {
    for (const { name, options } of screens) {
      const hidden = /headerShown:\s*false/.test(options);
      const titled = /title:\s*"[^"]+"/.test(options);
      expect(
        hidden || titled,
        `${name}: needs headerShown:false or an explicit title, or react-navigation renders the route name`
      ).toBe(true);
    }
  });

  it('never uses a route name as a visible label', () => {
    for (const { name, options } of screens) {
      for (const [, label] of options.matchAll(/(?:title|headerBackTitle):\s*"([^"]*)"/g)) {
        expect(ROUTEY.test(label), `${name}: "${label}" looks like a route, not a label`).toBe(
          false
        );
      }
    }
  });

  it('gives a back label to any screen pushed on top of a header-less one', () => {
    /**
     * The precise mechanism of the original bug. A back button's label comes
     * from the PREVIOUS screen's title — so a screen that shows a header and
     * can be pushed from a `headerShown: false` screen must supply its own
     * `headerBackTitle`, or there is no title to fall back to and the route
     * name is used.
     *
     * Every header-less screen in this app can push Settings (BottomNav,
     * TripHeader, StopsSection, trips/index, PlanRequiredOverlay), so the rule
     * applies to every screen that renders a header at all.
     */
    const withHeader = screens.filter((s) => !/headerShown:\s*false/.test(s.options));
    expect(withHeader.length).toBeGreaterThan(0);
    for (const { name, options } of withHeader) {
      expect(
        /headerBackTitle:\s*"[^"]+"/.test(options),
        `${name}: shows a header and can be pushed from a header-less screen, so it needs headerBackTitle`
      ).toBe(true);
    }
  });
});
