import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every paid Google call is counted, because the alternative was measured.
 *
 * On 2026-09-09 there were ELEVEN call sites of Google Directions, Places and
 * Geocoding across routes, repos and the Penny loop, and essentially none wrote
 * a `usage_events` row: `logGooglePlacesUsage` had had no caller since
 * 2026-06-29, and Directions and Geocoding never had one at all. The app's whole
 * Google spend was invisible — while CLAUDE.md simultaneously claimed those
 * calls were free (OSM/OSRM, removed in July), and an assistant built a fuel
 * cascade that multiplies them on the strength of that claim.
 *
 * The fix is a bounded module, the same shape as `src/server/payments/`:
 * `server/google/accounted.ts` wraps each client and logs on both the success
 * and the failure path (a failed call is billed like a successful one). This
 * guard is the boundary — asking eleven call sites to remember a log line is
 * precisely the design that failed.
 *
 * Decisions C1 and C2 in docs/decisions.md.
 */

const ROOT = join(__dirname, '..', '..');
const WRAPPER = 'src/server/google/accounted.ts';

/** The raw clients. Importing one outside the wrapper is an unmetered call. */
const RAW = [
  { defined_in: 'src/lib/google/directions.ts', symbol: 'getDirections' },
  { defined_in: 'src/lib/google/places.ts', symbol: 'searchFuelAlongRoute' },
  { defined_in: 'src/lib/google/geocode.ts', symbol: 'geocodePlace' },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'src'));
const wrapperSrc = readFileSync(join(ROOT, WRAPPER), 'utf8');

describe('paid Google calls go through the accounted wrapper', () => {
  for (const { symbol, defined_in } of RAW) {
    it(`nothing outside the wrapper calls ${symbol} directly`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const rel = relative(ROOT, file).split('\\').join('/');
        // The wrapper is the sanctioned caller; the client's own module is
        // where the function is DECLARED, which is not a call.
        if (rel === WRAPPER || rel === defined_in) continue;
        const src = readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          // The call, not the word: `getDirections(` but not
          // `getDirectionsAccounted(`.
          const re = new RegExp(`\\b${symbol}\\s*\\(`);
          if (re.test(line)) hits.push(`${rel}:${i + 1}`);
        });
      }
      expect(
        hits,
        `${symbol} is a PAID call. Use server/google/accounted.ts so it is counted.`,
      ).toEqual([]);
    });
  }
});

describe('the wrapper actually accounts', () => {
  it('logs on the success path of every wrapped call', () => {
    for (const fn of ['getDirectionsAccounted', 'searchFuelAlongRouteAccounted', 'geocodePlaceAccounted']) {
      expect(wrapperSrc, `${fn} is missing from the wrapper`).toContain(fn);
    }
    expect(wrapperSrc).toContain('logGooglePlacesUsage');
    expect(wrapperSrc).toContain('logGoogleApiUsage');
  });

  it('logs on the FAILURE path too — a failed call is billed the same', () => {
    // Both throwing wrappers must log before rethrowing.
    const catches = wrapperSrc.match(/catch \(err\) \{[\s\S]*?throw err;/g) ?? [];
    expect(catches.length, 'expected the two rethrowing wrappers').toBeGreaterThanOrEqual(2);
    for (const block of catches) {
      expect(block).toMatch(/success: false/);
    }
  });

  it('never lets accounting break the call it measures', () => {
    // Every log is fire-and-forget through `record`, which catches.
    expect(wrapperSrc).toMatch(/function record\([\s\S]*?\.catch\(/);
  });
});

describe('the usage logger the wrapper depends on', () => {
  const usage = readFileSync(join(ROOT, 'src/server/repos/usage.ts'), 'utf8');

  it('exports both loggers', () => {
    expect(usage).toContain('export async function logGooglePlacesUsage');
    expect(usage).toContain('export async function logGoogleApiUsage');
  });

  it('records the provider names the admin dashboard reads', () => {
    expect(usage).toContain("provider: 'google-places'");
    expect(usage).toContain("'google-directions'");
    expect(usage).toContain("'google-geocode'");
  });
});

describe('a trivial leg costs nothing (decision C10)', () => {
  const fuel = readFileSync(join(ROOT, 'src/server/fuel.ts'), 'utf8');

  it('short-circuits BEFORE any external call', () => {
    // A leg whose start ≈ end has nothing to fuel, and a zero-length route also
    // decodes to <2 points and hard-fails as "Route geometry was unusable" —
    // which was ~every failed leg in prod before the short-circuit existed.
    // Order is the whole property, so assert on position, not presence.
    const shortCircuit = fuel.indexOf('< TRIVIAL_LEG_KM');
    const firstDirections = fuel.indexOf('getDirectionsAccounted(');
    const firstPlaces = fuel.indexOf('searchFuelAlongRouteAccounted(');
    expect(shortCircuit, 'the trivial-leg short-circuit is gone').toBeGreaterThan(-1);
    expect(firstDirections).toBeGreaterThan(-1);
    expect(firstPlaces).toBeGreaterThan(-1);
    expect(shortCircuit, 'trivial-leg check must precede the Directions call').toBeLessThan(
      firstDirections,
    );
    expect(shortCircuit, 'trivial-leg check must precede the Places call').toBeLessThan(
      firstPlaces,
    );
  });

  it('returns ready rather than failing', () => {
    // The USE site, not the `const TRIVIAL_LEG_KM = 0.1` declaration.
    const at = fuel.indexOf('< TRIVIAL_LEG_KM');
    expect(at, 'the trivial-leg comparison is gone').toBeGreaterThan(-1);
    expect(fuel.slice(at, at + 400)).toMatch(/setFuelStatus\(legId, 'ready'\)/);
  });
});
