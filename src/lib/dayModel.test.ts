import { describe, it, expect } from 'vitest';
import {
  parseTimeToMinutes,
  minutesToTime,
  computeArrivalTime,
  canArriveSameDay,
  allocateDaysToFlexible,
  DEFAULT_DAY_MODEL_CONFIG,
  type DayModelConfig,
} from './dayModel';

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

describe('parseTimeToMinutes', () => {
  it('parses 08:00 → 480', () => {
    expect(parseTimeToMinutes('08:00')).toBe(480);
  });
  it('parses 15:00 → 900', () => {
    expect(parseTimeToMinutes('15:00')).toBe(900);
  });
  it('parses 00:00 → 0', () => {
    expect(parseTimeToMinutes('00:00')).toBe(0);
  });
  it('parses 23:59 → 1439', () => {
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });
  it('throws on garbage', () => {
    expect(() => parseTimeToMinutes('nope')).toThrow();
  });
});

describe('minutesToTime', () => {
  it('480 → 08:00', () => {
    expect(minutesToTime(480)).toBe('08:00');
  });
  it('900 → 15:00', () => {
    expect(minutesToTime(900)).toBe('15:00');
  });
  it('wraps 1500 → 01:00 (next day)', () => {
    expect(minutesToTime(1500)).toBe('01:00');
  });
  it('0 → 00:00', () => {
    expect(minutesToTime(0)).toBe('00:00');
  });
});

// ---------------------------------------------------------------------------
// computeArrivalTime
// ---------------------------------------------------------------------------

describe('computeArrivalTime', () => {
  const config = DEFAULT_DAY_MODEL_CONFIG;

  it('5h12m drive from 08:00 → arrives early afternoon', () => {
    // 312 min drive + 52 min breaks (312/60 * 10) + 30 min setup = 394 min
    // 08:00 + 394 min = 14:34
    const result = computeArrivalTime(312, config);
    expect(result.sameDay).toBe(true);
    expect(result.arrivalTime).toBe('14:34');
    expect(result.breakMinutes).toBe(52);
    expect(result.totalElapsedMinutes).toBe(394);
  });

  it('12h39m drive from 08:00 → arrives late evening', () => {
    // 759 min drive + 127 min breaks (759/60 * 10 ≈ 127) + 30 setup = 916
    // 08:00 + 916 min = 23:16
    const result = computeArrivalTime(759, config);
    expect(result.sameDay).toBe(true);
    const arrivalMin = parseTimeToMinutes(result.arrivalTime);
    // Should be late evening — after 22:00
    expect(arrivalMin).toBeGreaterThan(22 * 60);
  });

  it('short 2h drive → arrives mid-morning', () => {
    // 120 min drive + 20 min breaks + 30 setup = 170 min
    // 08:00 + 170 = 10:50
    const result = computeArrivalTime(120, config);
    expect(result.sameDay).toBe(true);
    expect(result.arrivalTime).toBe('10:50');
  });

  it('18h drive spills to next day', () => {
    // 1080 min drive + 180 breaks + 30 setup = 1290
    // 08:00 + 1290 = 29:30 → wraps to 05:30 next day
    const result = computeArrivalTime(1080, config);
    expect(result.sameDay).toBe(false);
  });

  it('respects custom departure time', () => {
    const earlyConfig: DayModelConfig = {
      ...config,
      typicalDepartureTime: '06:00',
    };
    // Same 5h12m drive but leaving 2h earlier
    const result = computeArrivalTime(312, earlyConfig);
    expect(result.sameDay).toBe(true);
    // 06:00 + 394 = 12:34
    expect(result.arrivalTime).toBe('12:34');
  });
});

// ---------------------------------------------------------------------------
// canArriveSameDay — THE BAD KISSINGEN TEST
// ---------------------------------------------------------------------------

describe('canArriveSameDay', () => {
  const config = DEFAULT_DAY_MODEL_CONFIG;

  it('Bad Kissingen: 5h12m drive, 15:00 deadline, default config → NOT feasible (setup overhead)', () => {
    // With default config (30min setup + 10min breaks/hr), this is
    // actually infeasible with a 60min buffer:
    // 312 drive + 52 breaks + 30 setup = 394 min → arrive 14:34
    // Deadline 15:00 - 60 buffer = 14:00 → 34min late
    //
    // This is correct and important! When driving to an appointment
    // (not setting up camp), the caller should use a transit config
    // with no setup overhead. See the "transit-mode" tests below.
    const result = canArriveSameDay(312, '15:00', 60, config);
    expect(result.feasible).toBe(false);
    expect(result.slackMinutes).toBe(-34);
  });

  it('Bad Kissingen with realistic final-leg config: no setup overhead', () => {
    // When driving to an appointment, there's no camp setup. You
    // arrive, park, walk in. Setup overhead doesn't apply.
    const noSetupConfig: DayModelConfig = {
      ...config,
      setupTeardownMinutes: 0,
    };
    const result = canArriveSameDay(312, '15:00', 60, noSetupConfig);
    // 312 + 52 breaks = 364 min → 08:00 + 364 = 14:04
    // Deadline 15:00 - 60 buffer = 14:00
    // Slack = 14:00 - 14:04 = -4 → barely infeasible
    // Hmm. 312/60 * 10 = 52. 312 + 52 = 364. 480 + 364 = 844. 844/60 = 14h4m = 14:04.
    // With 60 min buffer, effective deadline is 14:00. Slack = -4.
    // That's BARELY infeasible. With a 45min buffer it works.
    //
    // Real-world: 10min breaks per hour is conservative for highway
    // driving. Let's also test with 7min/hr (more realistic for
    // someone grinding a transit leg).
    expect(result.feasible).toBe(false);
    expect(result.slackMinutes).toBe(-4);
  });

  it('Bad Kissingen with transit-mode breaks (7min/hr) and no setup', () => {
    const transitConfig: DayModelConfig = {
      typicalDepartureTime: '08:00',
      breakMinutesPerDriveHour: 7,
      setupTeardownMinutes: 0,
    };
    const result = canArriveSameDay(312, '15:00', 60, transitConfig);
    // 312 + round(312/60 * 7) = 312 + 36 = 348 min
    // 08:00 + 348 = 13:48
    // Deadline 15:00 - 60 = 14:00, slack = 14:00 - 13:48 = 12 ✓
    expect(result.feasible).toBe(true);
    expect(result.slackMinutes).toBe(12);
  });

  it('Bad Kissingen with early departure (07:00)', () => {
    const earlyConfig: DayModelConfig = {
      typicalDepartureTime: '07:00',
      breakMinutesPerDriveHour: 10,
      setupTeardownMinutes: 0,
    };
    const result = canArriveSameDay(312, '15:00', 60, earlyConfig);
    // 312 + 52 = 364 min from 07:00 = 420 + 364 = 784 min = 13:04
    // Deadline 14:00, slack = 56 ✓
    expect(result.feasible).toBe(true);
    expect(result.slackMinutes).toBe(56);
  });

  it('short 3h drive to 17:00 deadline → very feasible', () => {
    const result = canArriveSameDay(180, '17:00', 60, config);
    expect(result.feasible).toBe(true);
    // 180 + 30 breaks + 30 setup = 240 min → 08:00 + 240 = 12:00
    // Deadline 17:00 - 60 = 16:00, slack = 240 min
    expect(result.slackMinutes).toBe(240);
  });

  it('14h drive to 18:00 deadline → not feasible', () => {
    const result = canArriveSameDay(840, '18:00', 60, config);
    // 840 + 140 + 30 = 1010 min → 08:00 + 1010 = 24:50 → next day
    expect(result.feasible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// allocateDaysToFlexible — THE INNSBRUCK ALLOCATION TEST
// ---------------------------------------------------------------------------

describe('allocateDaysToFlexible', () => {
  // Transit-mode config: lighter breaks, no setup (going straight to destination)
  const transitConfig: DayModelConfig = {
    typicalDepartureTime: '08:00',
    breakMinutesPerDriveHour: 7,
    setupTeardownMinutes: 0,
  };

  it('Bad Kissingen scenario: gives Innsbruck 4 nights, not 3', () => {
    // Departure: May 28
    // Segment 1: Girona → Innsbruck, 759 min drive, 1 drive day
    // Flexible: Innsbruck, wants "a few days" (min 2, preferred 4)
    // Segment 2: Innsbruck → Bad Kissingen, 312 min drive, 1 drive day
    // Deadline: June 3 at 15:00
    //
    // May 28 (day 1): drive Girona → Innsbruck
    // May 29-Jun 1 (4 nights): rest in Innsbruck
    // Jun 2 would be day 6: but wait...
    // Calendar days: May 28 to Jun 3 = 6 days
    // Drive days: 2
    // If same-day arrival on Jun 3: available flex = 6 - 2 = 4 ✓

    const result = allocateDaysToFlexible({
      departureDate: '2026-05-28',
      segments: [
        { driveMinutes: 759, driveDays: 1 },
        { driveMinutes: 312, driveDays: 1 },
      ],
      flexibleWaypoints: [
        { name: 'Innsbruck', minNights: 2, preferredNights: 4 },
      ],
      deadline: {
        datetime: '2026-06-03T15:00:00+02:00',
        localTime: '15:00',
        bufferMinutes: 60,
      },
      finalSegmentDriveMinutes: 312,
      config: transitConfig,
    });

    expect(result.sameDayArrival).toBe(true);
    expect(result.allocatedNights[0]).toBe(4);
    expect(result.totalDays).toBe(6); // 2 drive + 4 flex
    expect(result.slackMinutes).toBeGreaterThan(0);
  });

  it('no deadline → uses preferred nights', () => {
    const result = allocateDaysToFlexible({
      departureDate: '2026-05-28',
      segments: [
        { driveMinutes: 759, driveDays: 1 },
        { driveMinutes: 312, driveDays: 1 },
      ],
      flexibleWaypoints: [
        { name: 'Innsbruck', minNights: 2, preferredNights: 4 },
      ],
      deadline: null,
      finalSegmentDriveMinutes: 312,
    });

    expect(result.allocatedNights[0]).toBe(4);
    expect(result.totalDays).toBe(6);
  });

  it('tight deadline forces minimum nights', () => {
    // Departure May 28, deadline May 31 at 15:00 = only 3 days
    // 2 drive days → only 1 flex day available, but min is 2
    const result = allocateDaysToFlexible({
      departureDate: '2026-05-28',
      segments: [
        { driveMinutes: 759, driveDays: 1 },
        { driveMinutes: 312, driveDays: 1 },
      ],
      flexibleWaypoints: [
        { name: 'Innsbruck', minNights: 2, preferredNights: 4 },
      ],
      deadline: {
        datetime: '2026-05-31T15:00:00+02:00',
        localTime: '15:00',
        bufferMinutes: 60,
      },
      finalSegmentDriveMinutes: 312,
      config: transitConfig,
    });

    // Only 3 calendar days, 2 drive days = 1 flex day.
    // Min is 2, so it should flag the shortfall and use minimums.
    expect(result.allocatedNights[0]).toBe(2);
    expect(result.explanation).toContain('Tight');
  });

  it('multiple flex waypoints: distributes proportionally', () => {
    // 3 segments, 2 flex waypoints, deadline gives 8 flex days total
    // Waypoint A: min 1, preferred 3
    // Waypoint B: min 1, preferred 5
    // Total preferred: 8, total available: 6
    // Should compress proportionally: A gets ~2, B gets ~4
    const result = allocateDaysToFlexible({
      departureDate: '2026-06-01',
      segments: [
        { driveMinutes: 300, driveDays: 1 },
        { driveMinutes: 200, driveDays: 1 },
        { driveMinutes: 180, driveDays: 1 },
      ],
      flexibleWaypoints: [
        { name: 'City A', minNights: 1, preferredNights: 3 },
        { name: 'City B', minNights: 1, preferredNights: 5 },
      ],
      deadline: {
        datetime: '2026-06-10T18:00:00+02:00',
        localTime: '18:00',
        bufferMinutes: 60,
      },
      finalSegmentDriveMinutes: 180,
      config: transitConfig,
    });

    // 9 calendar days (Jun 1 to Jun 10), 3 drive days
    // Same-day arrival feasible (3h drive, 18:00 deadline)
    // Available flex: 9 - 3 = 6
    // Preferred total: 8, so we need to compress by 2
    // A: preferred 3, gets ~2. B: preferred 5, gets ~4.
    expect(result.sameDayArrival).toBe(true);
    expect(result.allocatedNights[0] + result.allocatedNights[1]).toBe(6);
    expect(result.allocatedNights[0]).toBeGreaterThanOrEqual(1);
    expect(result.allocatedNights[1]).toBeGreaterThanOrEqual(1);
    // B should get more than A (proportional to preference)
    expect(result.allocatedNights[1]).toBeGreaterThan(result.allocatedNights[0]);
  });

  it('plenty of time → gives preferred + distributes surplus', () => {
    // Departure Jun 1, deadline Jun 15, 2 drive days, 1 waypoint wanting 3 nights
    // Available flex: 14 - 2 = 12, preferred is 3 → surplus of 9
    const result = allocateDaysToFlexible({
      departureDate: '2026-06-01',
      segments: [
        { driveMinutes: 300, driveDays: 1 },
        { driveMinutes: 180, driveDays: 1 },
      ],
      flexibleWaypoints: [
        { name: 'Innsbruck', minNights: 2, preferredNights: 3 },
      ],
      deadline: {
        datetime: '2026-06-15T18:00:00+02:00',
        localTime: '18:00',
        bufferMinutes: 60,
      },
      finalSegmentDriveMinutes: 180,
      config: transitConfig,
    });

    // 14 calendar days, 2 drive, same-day arrival → 12 flex days
    // Preferred is 3, so surplus is 9 → all goes to Innsbruck
    expect(result.allocatedNights[0]).toBe(12);
  });

  it('same-day not feasible → arrives day before, one fewer flex day', () => {
    // Final segment is 14h drive — can't arrive same day
    const result = allocateDaysToFlexible({
      departureDate: '2026-06-01',
      segments: [
        { driveMinutes: 300, driveDays: 1 },
        { driveMinutes: 840, driveDays: 2 }, // 14h = needs 2 drive days
      ],
      flexibleWaypoints: [
        { name: 'City A', minNights: 1, preferredNights: 3 },
      ],
      deadline: {
        datetime: '2026-06-08T10:00:00+02:00',
        localTime: '10:00',
        bufferMinutes: 60,
      },
      finalSegmentDriveMinutes: 840,
      config: transitConfig,
    });

    expect(result.sameDayArrival).toBe(false);
    // 7 calendar days, 3 drive days, arrival penalty 1 → 3 flex days
    expect(result.allocatedNights[0]).toBe(3);
  });
});
