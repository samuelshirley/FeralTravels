import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The routable identity survives the `resolve_place → get_route → add_leg`
 * seam. Decision C11.
 *
 * THE BUG. `lib/google/geocode.ts` has always read `place_id` off the Places
 * response and put it on `GeocodeMatch`. `executeResolvePlace` then built a
 * payload of lat/lng/label/address/name_for_leg/granularity and dropped it, and
 * `get_route` had no field that could have carried it. So Penny was handed a
 * coordinate she could not route with and no way to ask for a better one — and
 * for a large national park that coordinate is the centroid of its POLYGON,
 * which for Zion is roadless backcountry. Measured 2026-09-10 on the live key:
 * the coordinate returns ZERO_RESULTS, the place_id returns a 1335 km route.
 *
 * On 2026-09-10 that cost a driver a fourteen-day extension to four more
 * national parks: twenty `get_route` calls, nothing written, and a paragraph
 * inventing a limit of "the app's routing engine" that does not exist.
 *
 * WHY THIS IS A SOURCE GUARD and not a behavioural test of `executeGetRoute`:
 * `src/lib/claude.ts` cannot be imported under vitest at all. Measured, not
 * assumed — `next@14.2.35` ships no `./server` entry in its export map, so
 * `next-auth/lib/env.js` fails to resolve the moment the module graph is
 * walked. The behaviour that CAN be tested properly is, and is:
 * `google/directions.test.ts` covers the query string, the cache key and the
 * harvest of the snapped points. What is left is the wiring between them, which
 * is what this file pins.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const claude = read('src/lib/claude.ts');
const getRouteTool = read('src/lib/penny/tools/getRoute.ts');
const geocode = read('src/lib/google/geocode.ts');

describe('the place_id survives every hop', () => {
  it('geocode still reads it off the Places response', () => {
    // The field has been here all along; it is the two hops after it that
    // dropped it. If this ever stops being true, nothing downstream can work.
    expect(geocode).toMatch(/place_id\?:\s*string/);
    expect(geocode).toMatch(/place_id:\s*p\.id/);
  });

  it('resolve_place hands it to Penny, on the match AND on the candidates', () => {
    // Candidates matter as much as the match: an `ambiguous` result is the one
    // the user picks FROM, and an id that only exists on the resolved branch is
    // an id that is missing exactly when a park had a near-twin.
    const occurrences = claude.match(/place_id:\s*(result\.match|c)\.place_id\s*\?\?\s*null/g) ?? [];
    expect(
      occurrences.length,
      'resolve_place must emit place_id on the resolved match, the other candidates and the ambiguous candidates',
    ).toBeGreaterThanOrEqual(3);
  });

  it('get_route ACCEPTS it — in the zod schema and in the schema Penny reads', () => {
    // Both halves or neither: the model can only send a field the JSON schema
    // advertises, and the server can only trust one zod validates.
    for (const field of ['origin_place_id', 'destination_place_id']) {
      expect(getRouteTool, `${field} missing from get_route`).toContain(field);
    }
    expect(getRouteTool).toMatch(/origin_place_id:\s*placeIdSchema/);
    expect(getRouteTool).toMatch(/destination_place_id:\s*placeIdSchema/);
    // Waypoints too — a park driven THROUGH has the same unreachable centroid.
    expect(getRouteTool).toMatch(/place_id:\s*placeIdSchema\.nullish\(\)/);
  });

  it('get_route USES it — the ids reach the Directions call', () => {
    const at = claude.indexOf('const directions = await getDirectionsAccounted(');
    expect(at, 'the get_route Directions call has moved').toBeGreaterThan(-1);
    const call = claude.slice(at, at + 900);
    expect(call).toContain('place_id: input.origin_place_id');
    expect(call).toContain('place_id: input.destination_place_id');
    // The waypoint list is built just above the call.
    expect(claude).toContain('place_id: w.place_id ?? null');
  });
});

describe('the snapped coordinates come back out', () => {
  it('routable_start/_end are read from the RESPONSE, not echoed from the input', () => {
    /*
     * The mutation this exists for is a one-word edit that looks like a
     * simplification: `routable_end: { lat: round5(input.destination_lat) … }`.
     * It would pass every other test in the repo, and it would silently put the
     * unroutable centroid back on the leg — where continuity repair, the replan
     * route and Finn's geometry all re-route from it days later, with no user
     * message to explain the failure.
     */
    const at = claude.indexOf('routable_start:');
    expect(at, 'routable_start is gone from the get_route payload').toBeGreaterThan(-1);
    const block = claude.slice(at, at + 400);
    expect(block).toContain('directions.start_location.lat');
    expect(block).toContain('directions.end_location.lat');
    expect(block).not.toContain('input.origin_lat');
    expect(block).not.toContain('input.destination_lat');
  });

  it('the tool description tells Penny to WRITE the leg with them', () => {
    // Harvesting a road-snapped point and then storing the centroid anyway
    // would be the whole fix, wasted.
    expect(getRouteTool).toMatch(/routable_start and routable_end/);
    expect(getRouteTool).toMatch(/in preference to the coordinates you passed in/);
  });

  it('the prompt states the data flow end to end', () => {
    const at = claude.indexOf('<place_resolution>');
    const end = claude.indexOf('</place_resolution>');
    expect(at).toBeGreaterThan(-1);
    const section = claude.slice(at, end);
    expect(section).toMatch(/place_id/);
    expect(section).toMatch(/routable_start and routable_end/);
    // Opaque handle: she forwards it, she never authors one. Same rule as
    // coordinates, and for the same reason.
    expect(section).toMatch(/[Nn]ever write one, edit one, or invent one/);
  });
});

describe('a failed lookup does not become a shrug', () => {
  it('no_results names the retry, and the old give-up line is gone', () => {
    /*
     * The deployed string was: "Try alternative coordinates or ask the user for
     * a different start/end." Penny did precisely that — offered Moab, then
     * asked the driver to choose. That is the instruction working, and the
     * instruction was wrong: a driver who names a real, reachable national park
     * is not somebody we are entitled to ask for a different destination.
     */
    expect(claude).not.toContain('Try alternative coordinates or ask the user for a different');
    expect(claude).toContain('function noRouteRemedy');
    const at = claude.indexOf('function noRouteRemedy');
    const fn = claude.slice(at, at + 2000);
    // The retry comes FIRST, and it is a real one — re-resolve, then re-route.
    expect(fn).toContain('resolve_place');
    expect(fn).toMatch(/retry properly first/);
    // Only after a genuine retry may she raise it, and then about THIS point.
    expect(fn).toMatch(/THIS point could not be routed to/);
  });

  it('NOT_FOUND is a bad reference, not an outage', () => {
    /*
     * Found by the trace this same change added, on its first real use: in one
     * re-walk of the incident Haiku emitted three `get_route` calls carrying
     * ids Google rejected outright. They fell through to the generic api_error
     * line and were reported as "this lookup is temporarily unavailable" —
     * untrue, unactionable, and the same shape of wrong answer the no_results
     * rewrite exists to remove.
     */
    expect(claude).toContain('BAD_PLACE_ID_REMEDY');
    expect(claude).toMatch(/directions\.status === "NOT_FOUND"/);
    const at = claude.indexOf('const BAD_PLACE_ID_REMEDY');
    const copy = claude.slice(at, at + 700);
    expect(copy).toContain('resolve_place');
    expect(copy).toMatch(/do NOT tell the user anything is/);
  });

  it('she may never characterise the system she is running inside', () => {
    /*
     * "This is a hard limit of the app's routing engine — it plans drivable
     * paved roads correctly for most of North America" was said to a real
     * driver about a trip that was perfectly drivable. She had no way to know
     * any of it. This is the same rule she already follows for distances,
     * applied to architecture.
     */
    const at = claude.indexOf('<routing_engine_limits>');
    const end = claude.indexOf('</routing_engine_limits>');
    expect(at).toBeGreaterThan(-1);
    const section = claude.slice(at, end);
    expect(section).toMatch(/NEVER CHARACTERISE THE SYSTEM/);
    expect(section).toMatch(/routing engine/);
    expect(section).toMatch(/you do not diagnose/i);
  });
});
