/**
 * The onboarding calendar's date maths — the one definition both calendars
 * draw from. A day is always a LOCAL calendar day; nothing may go via UTC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WEEKDAYS,
  dayLabel,
  dayNumber,
  localIso,
  monthGrid,
  monthTitle,
  stepMonth,
  toIso,
} from './calendarGrid';

const hostZone = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (hostZone === undefined) delete process.env.TZ;
  else process.env.TZ = hostZone;
});

/**
 * Run in a named zone. Node re-reads `TZ` on assignment, so the UTC-shift cases
 * below fail on a UTC CI box too, not only on a laptop west or east of it.
 */
function inZone(zone: string): void {
  process.env.TZ = zone;
}

describe('toIso / localIso', () => {
  it('pads month and day, and takes a 0-based month', () => {
    expect(toIso(2026, 0, 5)).toBe('2026-01-05');
    expect(toIso(2026, 11, 31)).toBe('2026-12-31');
  });

  it('keeps a late-evening local day as that day, not tomorrow in UTC', () => {
    // 23:30 local on 30 December. West of Greenwich (every US zone)
    // toISOString says the 31st — the bug this helper exists to rule out.
    inZone('America/Los_Angeles');
    const late = new Date(2026, 11, 30, 23, 30);
    expect(localIso(late)).toBe('2026-12-30');
  });

  it('keeps an early-morning local day as that day, not yesterday in UTC', () => {
    // East of Greenwich, 00:15 on 1 January is still 31 December in UTC.
    inZone('Asia/Tokyo');
    const early = new Date(2027, 0, 1, 0, 15);
    expect(localIso(early)).toBe('2027-01-01');
  });

  it('agrees with the fake clock the calendar reads today from', () => {
    inZone('America/New_York');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 1, 28, 23, 59));
    expect(localIso(new Date())).toBe('2026-02-28');
  });
});

describe('monthGrid', () => {
  it('starts on Monday, with blanks before the 1st', () => {
    // 1 October 2026 is a Thursday: three blanks (Mo, Tu, We).
    const cells = monthGrid(2026, 9);
    expect(cells.slice(0, 4)).toEqual([null, null, null, '2026-10-01']);
    expect(cells.at(-1)).toBe('2026-10-31');
  });

  it('has no blanks when the 1st is a Monday', () => {
    // 1 June 2026 is a Monday.
    expect(monthGrid(2026, 5)[0]).toBe('2026-06-01');
  });

  it('has six blanks when the 1st is a Sunday', () => {
    // 1 November 2026 is a Sunday.
    const cells = monthGrid(2026, 10);
    expect(cells.slice(0, 7)).toEqual([null, null, null, null, null, null, '2026-11-01']);
  });

  it('knows February in a leap year, and out of one', () => {
    expect(monthGrid(2028, 1).at(-1)).toBe('2028-02-29');
    expect(monthGrid(2026, 1).at(-1)).toBe('2026-02-28');
  });

  it('lists every day exactly once, in order', () => {
    const days = monthGrid(2026, 11).filter((c): c is string => c !== null);
    expect(days).toHaveLength(31);
    expect(days.map(dayNumber)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });
});

describe('stepMonth', () => {
  it('rolls the year over in both directions', () => {
    expect(stepMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(stepMonth({ year: 2027, month: 0 }, -1)).toEqual({ year: 2026, month: 11 });
  });
});

describe('labels', () => {
  it('titles the month', () => {
    expect(monthTitle(2026, 11)).toBe('December 2026');
    expect(monthTitle(2027, 0)).toBe('January 2027');
  });

  it('names a day in full, on the local calendar', () => {
    expect(dayLabel('2027-01-15')).toBe('Friday, January 15, 2027');
    expect(dayLabel('2026-12-31')).toBe('Thursday, December 31, 2026');
  });

  it('heads the columns Monday first', () => {
    expect(WEEKDAYS[0]).toBe('Mo');
    expect(WEEKDAYS.at(-1)).toBe('Su');
  });
});
