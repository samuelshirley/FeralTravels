/**
 * Tests for the deterministic scheduler. Pure function — no DB.
 *
 * The headline case is the bug that motivated this module: Girona → Innsbruck
 * → Bad Kissingen, departing May 28, with Bad Kissingen pinned to June 3. The
 * scheduler must place exactly the right rest days at Innsbruck and order every
 * leg chronologically, regardless of the desired-nights guess it starts from.
 */
import { describe, it, expect } from 'vitest';
import { materializeSchedule, type ScheduleStop } from './schedule';

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
