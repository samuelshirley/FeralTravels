/**
 * Tests for the deterministic scheduler. Pure function — no DB.
 *
 * The headline case is the bug that motivated this module: Girona → Innsbruck
 * → Bad Kissingen, departing May 28, with Bad Kissingen pinned to June 3. The
 * scheduler must place exactly the right rest days at Innsbruck and order every
 * leg chronologically, regardless of the desired-nights guess it starts from.
 */
import { describe, it, expect } from 'vitest';
import {
  materializeSchedule,
  computeStartFixes,
  resolveContinuityRoute,
  type ScheduleStop,
  type ContinuityLeg,
} from './schedule';
import type { GeoJSONLineString } from '@/types/trip';

function stop(overrides: Partial<ScheduleStop> & { driveId: string }): ScheduleStop {
  return {
    endName: null,
    endLat: null,
    endLng: null,
    desiredNights: 0,
    anchorDateISO: null,
    ...overrides,
  };
}

describe('materializeSchedule', () => {
  it('no anchors: respects desired nights and orders chronologically', () => {
    const r = materializeSchedule({
      tripStartISO: '2026-05-28',
      stops: [
        stop({ driveId: 'd0', desiredNights: 0 }), // Girona → Aix
        stop({ driveId: 'd1', desiredNights: 2 }), // Aix → Innsbruck, 2 nights
        stop({ driveId: 'd2', desiredNights: 0 }), // Innsbruck → Bad Kissingen
      ],
    });
    expect(r.nightsPerStop).toEqual([0, 2, 0]);
    expect(r.legs.map((l) => l.kind)).toEqual(['drive', 'drive', 'rest', 'rest', 'drive']);
    expect(r.legs.map((l) => l.dateISO)).toEqual([
      '2026-05-28', // d0
      '2026-05-29', // d1 (arrive Innsbruck)
      '2026-05-30', // rest
      '2026-05-31', // rest
      '2026-06-01', // d2
    ]);
    expect(r.infeasible).toEqual([]);
  });

  it('Bad Kissingen: expands Innsbruck to land the drive on June 3', () => {
    const r = materializeSchedule({
      tripStartISO: '2026-05-28',
      stops: [
        stop({ driveId: 'd0', desiredNights: 0 }),                       // Girona → Aix
        stop({ driveId: 'd1', desiredNights: 1 }),                       // Aix → Innsbruck (under-guessed)
        stop({ driveId: 'd2', anchorDateISO: '2026-06-03' }),            // Innsbruck → Bad Kissingen, pinned
      ],
    });
    // 2 drives before d2, June 3 is rank 6 → 4 rests must precede d2 → Innsbruck = 4.
    expect(r.nightsPerStop).toEqual([0, 4, 0]);
    const d2 = r.legs.find((l) => l.driveId === 'd2')!;
    expect(d2.dateISO).toBe('2026-06-03');
    expect(d2.rank).toBe(6);
    // rest days fall on the four days before June 3.
    expect(r.legs.filter((l) => l.kind === 'rest').map((l) => l.dateISO)).toEqual([
      '2026-05-30',
      '2026-05-31',
      '2026-06-01',
      '2026-06-02',
    ]);
    expect(r.infeasible).toEqual([]);
  });

  it('contracts an over-guessed stay to meet the deadline', () => {
    const r = materializeSchedule({
      tripStartISO: '2026-05-28',
      stops: [
        stop({ driveId: 'd0', desiredNights: 0 }),
        stop({ driveId: 'd1', desiredNights: 10 }), // user over-asked
        stop({ driveId: 'd2', anchorDateISO: '2026-06-03' }),
      ],
    });
    expect(r.nightsPerStop).toEqual([0, 4, 0]); // pulled down to fit
    expect(r.legs.find((l) => l.driveId === 'd2')!.dateISO).toBe('2026-06-03');
  });

  it('flags an impossible (too-early) fixed date', () => {
    const r = materializeSchedule({
      tripStartISO: '2026-05-28',
      stops: [
        stop({ driveId: 'd0', desiredNights: 0 }),
        stop({ driveId: 'd1', desiredNights: 0 }),
        stop({ driveId: 'd2', desiredNights: 0 }),
        // 3 driving days before d3, but the date is only 2 days after start.
        stop({ driveId: 'd3', anchorDateISO: '2026-05-30' }),
      ],
    });
    expect(r.infeasible).toHaveLength(1);
    expect(r.infeasible[0].stopIndex).toBe(3);
  });

  it('single drive, single anchor on day 1', () => {
    const r = materializeSchedule({
      tripStartISO: '2026-05-28',
      stops: [stop({ driveId: 'd0', anchorDateISO: '2026-05-28' })],
    });
    expect(r.nightsPerStop).toEqual([0]);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0].dateISO).toBe('2026-05-28');
  });

  it('cascades rest removal backward across multiple pre-anchor stops', () => {
    // Two pre-anchor stops each with desired nights; deadline needs fewer total.
    const r = materializeSchedule({
      tripStartISO: '2026-06-01',
      stops: [
        stop({ driveId: 'd0', desiredNights: 3 }),  // stop 0
        stop({ driveId: 'd1', desiredNights: 3 }),  // stop 1
        stop({ driveId: 'd2', anchorDateISO: '2026-06-05' }), // needs 3 rests before (rank 5 - 2 drives)
      ],
    });
    // target rests before d2 = (Jun5 - Jun1) - 2 = 4 - 2 = 2. Start had 6 → remove 4:
    // nearest-first: stop1 3→0 (removed 3), stop0 3→2 (removed 1). Total 2.
    expect(r.nightsPerStop).toEqual([2, 0, 0]);
    expect(r.legs.find((l) => l.driveId === 'd2')!.dateISO).toBe('2026-06-05');
  });
});

// ---------------------------------------------------------------------------
// Route continuity — the invariant that prevents "magic jumps".
// ---------------------------------------------------------------------------

const GIRONA = { lat: 41.98, lng: 2.82 };
const LYON = { lat: 45.76, lng: 4.84 };
const INNSBRUCK = { lat: 47.27, lng: 11.39 };
const BAD_KISSINGEN = { lat: 50.2, lng: 10.08 };
const NURBURGRING = { lat: 50.33, lng: 6.95 };

function driveLeg(
  start: { lat: number; lng: number } | null,
  end: { lat: number; lng: number } | null,
  endName: string | null,
): ContinuityLeg {
  return {
    legType: 'drive',
    startLat: start?.lat ?? null,
    startLng: start?.lng ?? null,
    endLat: end?.lat ?? null,
    endLng: end?.lng ?? null,
    endName,
  };
}

function restLeg(at: { lat: number; lng: number }, name: string | null): ContinuityLeg {
  return {
    legType: 'rest',
    startLat: at.lat,
    startLng: at.lng,
    endLat: at.lat,
    endLng: at.lng,
    endName: name,
  };
}

describe('computeStartFixes', () => {
  it('returns no fixes for an already-contiguous chain', () => {
    const legs: ContinuityLeg[] = [
      driveLeg(GIRONA, LYON, 'Lyon'),
      driveLeg(LYON, INNSBRUCK, 'Innsbruck'),
    ];
    expect(computeStartFixes(legs)).toEqual([]);
  });

  it('chains a drive across intervening rest days to the prior stop (the Nürburgring jump)', () => {
    // The reported bug: traveler is in Bad Kissingen (3 rest days), but the next
    // drive was authored starting from Innsbruck → Nürburgring.
    const legs: ContinuityLeg[] = [
      driveLeg(INNSBRUCK, BAD_KISSINGEN, 'Bad Kissingen'),
      restLeg(BAD_KISSINGEN, 'Bad Kissingen'),
      restLeg(BAD_KISSINGEN, 'Bad Kissingen'),
      restLeg(BAD_KISSINGEN, 'Bad Kissingen'),
      driveLeg(INNSBRUCK, NURBURGRING, 'Nürburgring'), // <- wrong origin
    ];
    const fixes = computeStartFixes(legs);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].index).toBe(4);
    expect(fixes[0].startLat).toBeCloseTo(BAD_KISSINGEN.lat);
    expect(fixes[0].startLng).toBeCloseTo(BAD_KISSINGEN.lng);
    expect(fixes[0].startName).toBe('Bad Kissingen');
  });

  it('fixes a drive leg with a missing start', () => {
    const legs: ContinuityLeg[] = [
      driveLeg(GIRONA, LYON, 'Lyon'),
      driveLeg(null, INNSBRUCK, 'Innsbruck'),
    ];
    const fixes = computeStartFixes(legs);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].index).toBe(1);
    expect(fixes[0].startName).toBe('Lyon');
  });

  it('never corrects the first leg (its start is the trip origin)', () => {
    const legs: ContinuityLeg[] = [
      driveLeg(null, LYON, 'Lyon'), // first leg, start unknown — left alone
      driveLeg(LYON, INNSBRUCK, 'Innsbruck'),
    ];
    expect(computeStartFixes(legs)).toEqual([]);
  });

  it('does not correct rest legs (already pinned to their stop)', () => {
    const legs: ContinuityLeg[] = [
      driveLeg(GIRONA, LYON, 'Lyon'),
      restLeg(INNSBRUCK, 'Innsbruck'),
    ];
    expect(computeStartFixes(legs)).toEqual([]);
  });

  it('skips a leg when the previous leg has no end coordinates', () => {
    const legs: ContinuityLeg[] = [
      driveLeg(GIRONA, null, null), // unknown destination — can't chain off it
      driveLeg(INNSBRUCK, NURBURGRING, 'Nürburgring'),
    ];
    expect(computeStartFixes(legs)).toEqual([]);
  });

  it('ignores sub-epsilon drift (Google-snapped endpoints a few metres off)', () => {
    const nudged = { lat: LYON.lat + 0.002, lng: LYON.lng + 0.002 }; // ~0.3 km
    const legs: ContinuityLeg[] = [
      driveLeg(GIRONA, LYON, 'Lyon'),
      driveLeg(nudged, INNSBRUCK, 'Innsbruck'),
    ];
    expect(computeStartFixes(legs)).toEqual([]);
  });

  it('corrects multiple drifted legs in one pass', () => {
    const legs: ContinuityLeg[] = [
      driveLeg(GIRONA, LYON, 'Lyon'),
      driveLeg(GIRONA, INNSBRUCK, 'Innsbruck'), // should start at Lyon
      driveLeg(GIRONA, NURBURGRING, 'Nürburgring'), // should start at Innsbruck
    ];
    const fixes = computeStartFixes(legs);
    expect(fixes.map((f) => f.index)).toEqual([1, 2]);
    expect(fixes[0].startName).toBe('Lyon');
    expect(fixes[1].startName).toBe('Innsbruck');
  });

  it('with a progress anchor, leaves the anchor leg and everything before it untouched', () => {
    // Driver has reported progress: leg index 2 is the current leg (its start is
    // their real position). Earlier legs are "behind you", and the anchor leg's
    // start must not be chained back to the prior leg — only legs AFTER it are fixed.
    const legs: ContinuityLeg[] = [
      driveLeg(GIRONA, LYON, 'Lyon'),
      driveLeg(GIRONA, INNSBRUCK, 'Innsbruck'), // drifts, but before the anchor → left alone
      driveLeg(GIRONA, NURBURGRING, 'Nürburgring'), // anchor (index 2) → never corrected
      driveLeg(GIRONA, BAD_KISSINGEN, 'Bad Kissingen'), // after anchor → corrected
    ];
    const fixes = computeStartFixes(legs, undefined, 2);
    expect(fixes.map((f) => f.index)).toEqual([3]);
    expect(fixes[0].startName).toBe('Nürburgring');
  });

  it('anchorIndex 0 matches the default (corrects from leg 1)', () => {
    const legs: ContinuityLeg[] = [
      driveLeg(GIRONA, LYON, 'Lyon'),
      driveLeg(GIRONA, INNSBRUCK, 'Innsbruck'),
    ];
    expect(computeStartFixes(legs, undefined, 0)).toHaveLength(1);
  });
});

describe('resolveContinuityRoute', () => {
  const geometry: GeoJSONLineString = {
    type: 'LineString',
    coordinates: [
      [10.08, 50.2],
      [6.95, 50.33],
    ],
  };

  it('on a successful re-route: adopts the route and clears any warning', () => {
    const r = resolveContinuityRoute(
      { ok: true, distanceKm: 312, driveTimeMinutes: 240, geometry },
      'Bad Kissingen',
      'Nürburgring',
    );
    expect(r.rerouted).toBe(true);
    expect(r.distanceKm).toBe(312);
    expect(r.driveTimeMinutes).toBe(240);
    expect(r.geometry).toEqual(geometry);
    expect(r.continuityWarning).toBeNull();
  });

  it('on the noroute branch: clears distance/time/geometry AND sets a warning', () => {
    const r = resolveContinuityRoute({ ok: false }, 'Glacier National Park', 'Old Faithful, Yellowstone');
    expect(r.rerouted).toBe(false);
    expect(r.distanceKm).toBeNull();
    expect(r.driveTimeMinutes).toBeNull();
    expect(r.geometry).toBeNull();
    expect(r.continuityWarning).not.toBeNull();
    // Warning names both endpoints in plain language so the card explains itself.
    expect(r.continuityWarning).toContain('Glacier National Park');
    expect(r.continuityWarning).toContain('Old Faithful, Yellowstone');
  });

  it('treats a partial/invalid success (ok but missing fields) as noroute', () => {
    // A "success" with no distance is not usable — must not poison the summary.
    const r = resolveContinuityRoute(
      { ok: true, driveTimeMinutes: 240, geometry },
      'A',
      'B',
    );
    expect(r.rerouted).toBe(false);
    expect(r.distanceKm).toBeNull();
    expect(r.continuityWarning).not.toBeNull();
  });

  it('falls back to generic endpoint names when they are null', () => {
    const r = resolveContinuityRoute({ ok: false }, null, null);
    expect(r.continuityWarning).toContain('the previous stop');
    expect(r.continuityWarning).toContain('this stop');
  });
});
