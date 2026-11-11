import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A fuel station's NAME is never stored (Sam, 2026-11-11).
 *
 * Google's Maps Platform terms (§3.2.3) forbid caching business names. The app
 * stores a station's `place_id` and shows "Fuel stop · 89 km"; the name is
 * fetched fresh on a tap (`GET /api/stops/:id/place-name`) and lives only in
 * that response and the card's state while it is open. Two code paths ever
 * hold a Places `displayName`, and this pins both, plus every place the new
 * one travels:
 *
 *  1. Finn's text search asks for `displayName` (to filter truck stops) — every
 *     stop Finn writes is named the constant `FUEL_STOP_NAME`.
 *  2. The Place Details call lives in ONE raw client, called by ONE accounted
 *     wrapper, called by ONE route. The wrapper logs the call and its cost,
 *     never the name; the raw client's errors carry a status, never a body.
 *  3. The route reads, never writes: no DB client, no repo write, no log of
 *     the name, `Cache-Control: no-store`.
 *  4. Neither client puts it in a cache: the files that call `loadStationName` import
 *     no resource cache, AsyncStorage or localStorage.
 *
 * Registered in docs/decisions.md. Prose: docs/design/finn-fuel-agent.md.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(relative(ROOT, p));
    }
  }
  return out;
}
const app = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'mobile', 'app')), ...walk(join(ROOT, 'mobile', 'components')), ...walk(join(ROOT, 'mobile', 'lib'))].filter(
  (f) => !f.startsWith('src/test/'),
);
const using = (re: RegExp) => app.filter((f) => re.test(read(f)));

const RAW = 'src/lib/google/placeDetails.ts';
const WRAPPER = 'src/server/google/accounted.ts';
const ROUTE = 'src/app/api/stops/[id]/place-name/route.ts';

describe('a station name is never stored', () => {
  it('Finn names every stop it writes FUEL_STOP_NAME, never a Places name', () => {
    const fuel = read('src/server/fuel.ts');
    const names = [...fuel.matchAll(/^\s*name:\s*([^,\n]+),?$/gm)].map((m) => m[1].trim());
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(['FUEL_STOP_NAME']));
  });

  it('the Place Details endpoint is called from one raw client, one wrapper, one route', () => {
    expect(using(/places\.googleapis\.com\/v1\/places\//)).toEqual([RAW]);
    // Definition or call sites (`name(`), not doc comments that mention them.
    expect(using(/\bfetchPlaceDisplayName\s*\(/).sort()).toEqual([RAW, WRAPPER].sort());
    expect(using(/\bfetchPlaceDisplayNameAccounted\s*\(/).sort()).toEqual([WRAPPER, ROUTE].sort());
  });

  it("the raw client's errors carry a status, never what Google returned", () => {
    const src = read(RAW);
    const throws = [...src.matchAll(/throw new Error\(([^;]+)\);/g)].map((m) => m[1]);
    expect(throws.length).toBeGreaterThan(0);
    for (const t of throws) expect(t, t).not.toMatch(/\$\{\s*(text|json|body|res\.text|await)/);
  });

  it('the wrapper logs the call and its cost, never the name', () => {
    const src = read(WRAPPER);
    const body = src.slice(src.indexOf('export async function fetchPlaceDisplayNameAccounted'));
    const okLog = body.slice(body.indexOf('const name = await'), body.indexOf('return name;'));
    expect(okLog).toMatch(/logGooglePlacesUsage\(/);
    // The success row carries no message at all, and nothing is fed the name.
    expect(okLog).not.toMatch(/errorMessage/);
    expect(okLog).not.toMatch(/:\s*name\b/);
  });

  it('the route reads and returns; it writes nothing and logs no name', () => {
    const src = read(ROUTE);
    expect(src).not.toMatch(/@\/server\/db\/client/);
    expect(src).not.toMatch(/\b(insert|update|delete)\(|\b(add|update|set|upsert|create)[A-Z]\w*\(/);
    expect(src).not.toMatch(/console\.\w+\([^)]*\bname\b/);
    expect(src).toMatch(/'Cache-Control': 'no-store'/);
  });

  it('no client puts the name in a cache', () => {
    const callers = using(/\bloadStationName\(/).filter((f) => f !== 'src/lib/stationName.ts' && f !== 'mobile/shared/lib/stationName.ts');
    expect(callers.sort()).toEqual(['mobile/components/StopsSection.tsx', 'src/components/StopsSection.tsx']);
    for (const f of callers) {
      const src = read(f);
      // A cache module imported, or browser storage written — not a comment that names one.
      expect(src, f).not.toMatch(/from\s+['"][^'"]*(resourceCache|async-storage|secure-store|lib\/cache)['"]/);
      expect(src, f).not.toMatch(/\b(localStorage|sessionStorage)\s*\./);
    }
  });

  it('both stop cards offer the tap and show its result (iOS held here; web is render-tested)', () => {
    const web = read('src/components/StopsSection.tsx');
    const ios = read('mobile/components/StopsSection.tsx');
    expect(web).toMatch(/data-testid="fuel-stop-name"/);
    expect(ios).toMatch(/testID="fuel-stop-name"/);
    for (const [f, src] of [['web', web], ['ios', ios]] as const) {
      expect(src, f).toMatch(/loadStationName\(\(path\) => apiFetch\(path\), stopId\)/);
      expect(src, f).toMatch(/canName:\s*fuel && !!stop\.place_id/);
    }
    // iOS renders the name and the failure line through the shared row body.
    expect(ios).toMatch(/stationName: row\.stationName,\s*nameNote: row\.nameNote,/);
    const body = read('mobile/components/RouteTimelineRow.tsx');
    expect(body).toMatch(/namedFuelStopLabel\(row\.stationName/);
    expect(body).toMatch(/testID="fuel-stop-name-error"/);
  });
});
