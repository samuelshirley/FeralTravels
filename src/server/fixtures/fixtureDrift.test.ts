import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_LEGS, CANONICAL_TRIP_META, CANONICAL_TRIP_NOT_CARRIED } from './canonicalTrip';

/**
 * The fixture must go stale LOUDLY.
 *
 * The problem this exists for, in the owner's words: "let's say I do an update,
 * a new feature, it adds some new table to the database that would make this
 * previous clone old data."
 *
 * That is the real failure mode of every extracted fixture, and it is silent by
 * construction. A migration adds `legs.weather_note`; the seeder does not set
 * it; every seeded leg gets NULL; the specs stay green because they were
 * written before the column existed — and the fixture now describes a trip the
 * app can no longer produce. Nothing breaks. It just stops being a test of the
 * current app, and nobody finds out until a real user hits the path.
 *
 * `cloneTripColumns.test.ts` solves the same shape for `cloneTrip` and this is
 * that idea pointed at the fixture, with one addition it needs and cloneTrip
 * does not: **new TABLES**, not just new columns. Any table with a `trip_id` or
 * `leg_id` foreign key is trip content by definition, so the schema itself
 * tells us what a complete trip is — no list to keep up to date, and a new
 * trip-scoped table fails here the day its migration lands.
 *
 * This is a lint, not a proof. It cannot tell you a VALUE is right, only that
 * somebody looked at the column. That is the whole ask: make the decision
 * explicit instead of defaulted.
 */

const ROOT = join(__dirname, '..', '..', '..');
const schemaSrc = readFileSync(join(ROOT, 'src/server/db/schema.ts'), 'utf8');

/**
 * The source text of one `pgTable` declaration.
 *
 * Bounded by the NEXT `export const`, not by the next `\n);`. The first version
 * used the latter and produced a false positive on the first run: `appMeta` has
 * no index callback and no `\n);` of its own on the line the naive scan looked
 * for, so its "block" ran on into `usageEvents` and inherited that table's
 * `references(() => trips.id)`. A guard that reports a table which is not
 * trip-scoped teaches people to skim its output, which is the one thing a guard
 * cannot afford.
 */
function tableBlock(table: string): string {
  const start = schemaSrc.indexOf(`export const ${table} = pgTable(`);
  if (start === -1) throw new Error(`table ${table} not found in schema.ts`);
  const nextDecl = schemaSrc.indexOf('\nexport const ', start + 1);
  const hardEnd = nextDecl === -1 ? schemaSrc.length : nextDecl;
  const indexCb = schemaSrc.indexOf('\n  (t)', start);
  return schemaSrc.slice(start, indexCb !== -1 && indexCb < hardEnd ? indexCb : hardEnd);
}

function columnsOf(table: string): string[] {
  return [...tableBlock(table).matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);
}

/** Every `export const <name> = pgTable(` in the schema. */
function allTables(): string[] {
  return [...schemaSrc.matchAll(/export const ([a-zA-Z][a-zA-Z0-9]*) = pgTable\(/g)].map((m) => m[1]);
}

describe('canonical fixture does not silently go stale', () => {
  /**
   * Trip-level columns. Every one is set by the fixture, defaulted on purpose,
   * or on the not-carried list with a reason in `canonicalTrip.ts`.
   */
  it('accounts for every column on the trips table', () => {
    const declared = columnsOf('trips');
    const carried = new Set<string>([
      ...Object.keys(CANONICAL_TRIP_META),
      ...CANONICAL_TRIP_NOT_CARRIED,
      'name', // CANONICAL_TRIP_NAME
    ]);
    const unaccounted = declared.filter((c) => !carried.has(c));
    expect(
      unaccounted,
      `New trips columns the canonical fixture says nothing about:\n` +
        unaccounted.map((c) => `  - ${c}`).join('\n') +
        `\n\nA seeded trip will get the column's DEFAULT, which may be a state the app ` +
        `cannot otherwise reach. Either add it to CANONICAL_TRIP_META, or to ` +
        `CANONICAL_TRIP_NOT_CARRIED with the reason, in src/server/fixtures/canonicalTrip.ts.`
    ).toEqual([]);
  });

  /** Leg-level columns, same rule. */
  it('accounts for every column on the legs table', () => {
    const declared = columnsOf('legs');
    const carried = new Set<string>([
      ...Object.keys(CANONICAL_LEGS[0]),
      'geometry',           // stored encoded in canonicalTripGeometry.ts
      'fuelStopsUpdatedAt', // stored as fuelCacheAgeHours, resolved at seed time
      'dates',              // derived per-leg from the trip start
      'id', 'tripId', 'createdAt', 'updatedAt',
      'fuelPlanError',      // null on a healthy trip; a failure fixture sets it
      'continuityWarning',  // null on a continuous trip — asserted continuous
    ]);
    const unaccounted = declared.filter((c) => !carried.has(c));
    expect(
      unaccounted,
      `New legs columns the canonical fixture says nothing about:\n` +
        unaccounted.map((c) => `  - ${c}`).join('\n') +
        `\n\nAdd them to CanonicalLeg and re-extract (npm run extract-canonical-trip), ` +
        `or add them to the allowlist in this test with the reason they are defaulted.`
    ).toEqual([]);
  });

  /** Stop-level columns, same rule. */
  it('accounts for every column on the stops table', () => {
    const declared = columnsOf('stops');
    const sample = CANONICAL_LEGS.flatMap((l) => l.stops)[0];
    expect(sample, 'the fixture has no stops to check — that is itself the bug').toBeTruthy();
    const carried = new Set<string>([
      ...Object.keys(sample),
      'id', 'legId', 'createdAt', 'updatedAt',
      'sortOrder',     // the fixture's array order IS the sort order
      'fuelAmountL',   // set by the driver at the pump, not by planning
      'sourceUrl',     // superseded by googleMapsUri for Google-sourced stops
      'alternatives',  // the source trip's stops carry none
      'photos',        // dormant column, always null
    ]);
    const unaccounted = declared.filter((c) => !carried.has(c));
    expect(
      unaccounted,
      `New stops columns the canonical fixture says nothing about:\n` +
        unaccounted.map((c) => `  - ${c}`).join('\n')
    ).toEqual([]);
  });

  /**
   * NEW TABLES — the half a column check misses, and the one the owner asked
   * about. Anything holding a `trip_id` or `leg_id` is part of a trip, so the
   * schema tells us what a complete trip is without a list to maintain.
   */
  it('knows about every trip-scoped table in the schema', () => {
    const tripScoped = allTables().filter((t) => {
      const block = tableBlock(t);
      return /references\(\(\) => (trips|legs)\.id/.test(block);
    });

    /**
     * Tables that are trip-scoped but deliberately NOT part of the canonical
     * fixture. Each is a decision; adding one here is how you record it.
     */
    const notInFixture: Record<string, string> = {
      chatHistory: 'generated per-seed by seedTranscript — cloning the real transcript ships stale calendar dates (see 732eda4)',
      routes: 'the source trip has none; nav links are derived from leg endpoints at render time',
      routeLinks: 'child of routes, which the fixture does not carry',
      costs: 'the source trip has none',
      links: 'the source trip has none',
      tasks: 'the source trip has none, and a task list is not part of the itinerary under test',
      pois: 'points of interest are fetched, not planned — a seeded trip has none',
      usageEvents: 'accounting, not trip content; the subscription fixture writes these',
      pennyTurns: 'the turn queue — idempotency keys and results of requests already served. The source trip has three; they are a record of HTTP calls, not of an itinerary, and a freshly seeded account has made none. A spec about turn resilience seeds its own.',
      legConstraints: 'the source trip has none — no leg carries a user constraint. A spec about constraints sets one explicitly, which is also the only way it says what it is testing.',
      gpxTrails: 'uploaded track files. The source trip has none, and a fixture has no business shipping binary route data.',
    };

    const inFixture = new Set(['legs', 'stops']);
    const unaccounted = tripScoped.filter((t) => !inFixture.has(t) && !(t in notInFixture));

    expect(
      unaccounted,
      `New trip-scoped table(s) the canonical fixture says nothing about:\n` +
        unaccounted.map((t) => `  - ${t}`).join('\n') +
        `\n\nA migration added a table that hangs off trips or legs. A seeded trip now ` +
        `has none of those rows, so every spec touching the new feature tests an empty ` +
        `case and passes for the wrong reason. Either extend the fixture and the seeder, ` +
        `or add the table to notInFixture in this test with the reason it does not belong.`
    ).toEqual([]);
  });

  /**
   * The guard's own regression. `appMeta` is two columns and no foreign keys;
   * if it ever shows up as trip-scoped again, the block scanner has broken in
   * the same way it broke the first time this file ran.
   */
  it('does not mistake a neighbouring table for a trip-scoped one', () => {
    expect(tableBlock('appMeta')).not.toMatch(/references\(\) => (trips|legs)\.id/);
    expect(tableBlock('appMeta').length).toBeLessThan(400);
  });

  it('the not-carried lists have no stale entries', () => {
    const tripCols = new Set(columnsOf('trips'));
    const stale = CANONICAL_TRIP_NOT_CARRIED.filter((c) => !tripCols.has(c));
    expect(stale, `CANONICAL_TRIP_NOT_CARRIED names columns that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });
});
