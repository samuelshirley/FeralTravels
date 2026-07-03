import { describe, it, expect, vi } from 'vitest';

// `server-only` (pulled in via ./geo) throws under the jsdom test env; stub it
// (hoisted above imports) — same pattern as newLegFallback.test.ts.
vi.mock('server-only', () => ({}));

import { findGapCreatingDeletes, type GateLeg } from './contiguityGate';
import type { ValidatedAction } from './tools';

/**
 * Chain of legs along increasing latitude, ~111 km per 1° of lat. Each leg
 * ends where the next starts unless a gap is injected.
 */
function makeLeg(
  id: string,
  sortOrder: number,
  startLat: number,
  endLat: number,
): GateLeg {
  return { id, sortOrder, startLat, startLng: 10, endLat, endLng: 10 };
}

function del(legId: string): ValidatedAction {
  return { name: 'delete_leg', input: { leg_id: legId } } as ValidatedAction;
}

/** Contiguous 5-leg chain: A(0→1) B(1→2) C(2→3) D(3→4) E(4→5). */
function contiguousTrip(): GateLeg[] {
  return [
    makeLeg('A', 0, 60, 61),
    makeLeg('B', 1, 61, 62),
    makeLeg('C', 2, 62, 63),
    makeLeg('D', 3, 63, 64),
    makeLeg('E', 4, 64, 65),
  ];
}

/** Same chain but with a PRE-EXISTING ~222km gap between A and B. */
function trippedWithExistingGap(): GateLeg[] {
  const legs = contiguousTrip();
  legs[1] = makeLeg('B', 1, 63, 64); // A ends 61, B starts 63 → ~222km gap
  legs[2] = makeLeg('C', 2, 64, 65);
  legs[3] = makeLeg('D', 3, 65, 66);
  legs[4] = makeLeg('E', 4, 66, 67);
  return legs;
}

describe('findGapCreatingDeletes', () => {
  it('blocks a mid-route delete that creates a new gap', () => {
    const blocked = findGapCreatingDeletes(contiguousTrip(), [del('C')]);
    expect(blocked).toEqual(new Set(['C']));
  });

  it('allows deleting the trailing legs (tail delete creates no gap)', () => {
    const blocked = findGapCreatingDeletes(contiguousTrip(), [del('D'), del('E')]);
    expect(blocked.size).toBe(0);
  });

  it('allows deleting the leading legs (head delete creates no gap)', () => {
    const blocked = findGapCreatingDeletes(contiguousTrip(), [del('A'), del('B')]);
    expect(blocked.size).toBe(0);
  });

  it('allows a mid-route delete when a neighbor update closes the gap', () => {
    const actions: ValidatedAction[] = [
      {
        name: 'update_leg',
        input: { leg_id: 'B', data: { end_lat: 63, end_lng: 10 } },
      } as ValidatedAction,
      del('C'),
    ];
    const blocked = findGapCreatingDeletes(contiguousTrip(), actions);
    expect(blocked.size).toBe(0);
  });

  it('REGRESSION: a pre-existing gap elsewhere must not block an unrelated tail delete', () => {
    // The 2026-07-02 incident: "delete all stops after Tromsø" — every delete
    // in the batch was blocked because the trip already had a 217km gap near
    // its start, which no amount of un-deleting could remove. Suffix deletes
    // can never create a gap; they must all pass.
    const blocked = findGapCreatingDeletes(trippedWithExistingGap(), [
      del('C'),
      del('D'),
      del('E'),
    ]);
    expect(blocked.size).toBe(0);
  });

  it('still blocks a delete that creates a NEW gap on a trip with a pre-existing gap', () => {
    // Deleting D from A B C D E (existing gap A→B) creates a new C→E gap.
    const blocked = findGapCreatingDeletes(trippedWithExistingGap(), [del('D')]);
    expect(blocked).toEqual(new Set(['D']));
  });

  it('returns empty for no deletes or tiny trips', () => {
    expect(findGapCreatingDeletes(contiguousTrip(), []).size).toBe(0);
    expect(findGapCreatingDeletes([makeLeg('A', 0, 60, 61)], [del('A')]).size).toBe(0);
  });

  it('ignores deletes of unknown leg ids', () => {
    const blocked = findGapCreatingDeletes(contiguousTrip(), [del('nope')]);
    expect(blocked.size).toBe(0);
  });

  it('blocks all deletes conservatively when new gaps have no single culprit', () => {
    // Deleting B and D together: un-deleting either alone still leaves a new
    // gap from the other → no isolated culprit → block both.
    const blocked = findGapCreatingDeletes(contiguousTrip(), [del('B'), del('D')]);
    expect(blocked).toEqual(new Set(['B', 'D']));
  });

  it('blocks deleting a coordless leg when the resulting adjacency exposes a real gap', () => {
    // A→B and B→C are uncheckable (B has no coords) so there's no baseline
    // gap; deleting B makes A adjacent to C with a ~111km hole — a NEW gap.
    const legs: GateLeg[] = [
      makeLeg('A', 0, 60, 61),
      { id: 'B', sortOrder: 1, startLat: null, startLng: null, endLat: null, endLng: null },
      makeLeg('C', 2, 62, 63),
    ];
    const blocked = findGapCreatingDeletes(legs, [del('B')]);
    expect(blocked).toEqual(new Set(['B']));
  });

  it('allows deleting a coordless TAIL leg (no new adjacency forms)', () => {
    const legs: GateLeg[] = [
      makeLeg('A', 0, 60, 61),
      makeLeg('B', 1, 61, 62),
      { id: 'C', sortOrder: 2, startLat: null, startLng: null, endLat: null, endLng: null },
    ];
    const blocked = findGapCreatingDeletes(legs, [del('C')]);
    expect(blocked.size).toBe(0);
  });
});
