/**
 * Finn never saves a Google station's name or Google's link, and every screen
 * labels a fuel stop "Fuel stop · 212 km".
 *
 * Until 2026-10-07 Finn stored `station.name ?? station.brand` as the stop's
 * name and the Place's `googleMapsUri` as its link. Google Maps Platform ToS
 * §3.2.3 forbids caching business names, and `googleMapsUri` has no caching
 * allowance; only the `place_id` may be kept. So the row now carries
 * FUEL_STOP_NAME and our own drive link (coords + place_id), and the clients
 * word it with `fuelStopLabel`. Migration 0046 rewrote the rows saved before.
 *
 * Finn may still READ a station's name in memory (the truck filter in
 * finn/stationFilter.ts); this guard is about what reaches the `stops` table.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const FUEL = 'src/server/fuel.ts';
const fuelSrc = readFileSync(join(ROOT, FUEL), 'utf8');

/** Every `insert(stops).values({ … })` object literal in a source file. */
function stopsInserts(src: string): string[] {
  const out: string[] = [];
  const re = /\.insert\(stops\)\s*\.values\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

/** The value expression written to `column` in an insert literal, or null. */
function columnValue(insert: string, column: string): string | null {
  const m = insert.match(new RegExp(`\\n\\s*${column}:\\s*([^\\n]*)`));
  return m ? m[1].trim() : null;
}

describe("Finn's stops insert stores no Google business data", () => {
  const inserts = stopsInserts(fuelSrc);

  it('finds the insert it guards', () => {
    expect(inserts.length, `no insert(stops).values({…}) in ${FUEL}`).toBeGreaterThanOrEqual(1);
  });

  it('names every fuel stop FUEL_STOP_NAME, never the station', () => {
    for (const insert of inserts) {
      expect(columnValue(insert, 'name')).toBe('FUEL_STOP_NAME,');
    }
  });

  it("writes no station name, brand, displayName or Google link into any column", () => {
    for (const insert of inserts) {
      for (const banned of ['station.name', 'station.brand', 'displayName', 'station.googleMapsUri']) {
        expect(insert, `${FUEL} writes ${banned} into stops`).not.toContain(banned);
      }
    }
  });

  it('links to our own drive URL from coordinates and place_id', () => {
    expect(fuelSrc).toMatch(
      /buildGoHereUrl\(station\.lat, station\.lng, \{ placeId: station\.placeId \}\)/
    );
    for (const insert of inserts) {
      for (const column of ['googleMapsUri', 'sourceUrl']) {
        const value = columnValue(insert, column);
        expect(value, `${column} must be the drive URL`).toBe('driveUrl,');
      }
    }
  });

  it('keeps the indirection out too: no local copied from a station name', () => {
    // `const name = station.name ?? …; … name,` is the shape this replaced.
    expect(fuelSrc).not.toMatch(/=\s*station\.(name|brand)\b/);
    expect(fuelSrc).not.toMatch(/=\s*station\.googleMapsUri\b/);
  });
});

/**
 * Every place a fuel stop is shown words it with `fuelStopLabel`, so a row
 * saved before migration 0046 (still carrying a station name) renders the same
 * as a new one, and the label is one sentence everywhere.
 */
describe('every fuel-stop render site uses fuelStopLabel', () => {
  const SITES = [
    'src/components/Itinerary.tsx',
    'src/components/StopsSection.tsx',
    'src/components/stops/StopCard.tsx',
    'src/components/TripMap.tsx',
    'src/components/LegCard.tsx',
    'src/app/trips/TripCard.tsx',
    'mobile/components/Itinerary.tsx',
    'mobile/components/StopsSection.tsx',
    'mobile/components/StopCard.tsx',
    'mobile/components/TripMap.tsx',
    'mobile/components/LegCard.tsx',
    'mobile/components/TripCard.tsx',
  ];
  for (const site of SITES) {
    it(site, () => {
      expect(readFileSync(join(ROOT, site), 'utf8')).toContain('fuelStopLabel(');
    });
  }
});
