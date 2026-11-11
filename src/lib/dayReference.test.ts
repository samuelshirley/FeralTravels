import { describe, expect, it } from 'vitest';

import { parseDayReference, type DayFrame } from './dayReference';

/**
 * Case 2's day: is a free, deterministic parse enough to put a pasted place
 * on the day the driver named? These are the phrasings a "add this to day 3"
 * message comes in. The ones it reads are read to the right day; the ones it
 * cannot read say so ("none", "ambiguous", "no_start") rather than guess.
 *
 * What this file CANNOT say is how often real drivers use each form — that is
 * what the compare rows' `dayParseKind` / `dayMatch` measure in production,
 * against the day Penny actually chose (/admin, "day parse").
 */

// A 7-day trip starting Thursday 2026-11-12; today is Wednesday 2026-11-11.
const FRAME: DayFrame = { dayCount: 7, tripStartISO: '2026-11-12', todayISO: '2026-11-11' };
const day = (message: string, frame: DayFrame = FRAME) => parseDayReference(message, frame);

describe('reads the forms a driver uses, to the right day', () => {
  it.each([
    ['add this to day 3 https://maps.app.goo.gl/abc', 'day_number', 3],
    ['Day 3 please', 'day_number', 3],
    ['put it on day3', 'day_number', 3],
    ['day three', 'day_number', 3],
    ['on the third day', 'ordinal', 3],
    ['the 3rd day', 'ordinal', 3],
    ['first day', 'ordinal', 1],
    ['the last day', 'last', 7],
    ['final day, on the way home', 'last', 7],
    ['tomorrow', 'relative', 1], // today is the day before the trip
    ['the day after tomorrow', 'relative', 2],
    ['on 2026-11-14', 'date', 3],
    ['Nov 14', 'date', 3],
    ['November 14th', 'date', 3],
    ['14 November', 'date', 3],
    ['the 14th of November', 'date', 3],
    ['the 14th', 'date', 3],
    ['on Saturday', 'weekday', 3], // 2026-11-14 is a Saturday
    ['day 3 — that is Nov 14', 'day_number', 3], // two forms, one day: agreed
  ] as const)('%s → %s %i', (message, kind, n) => {
    expect(day(message)).toEqual({ kind, day: n, inRange: true });
  });
});

describe('says when it cannot tell, rather than guessing', () => {
  it('no day named → none', () => {
    expect(day('add this https://maps.app.goo.gl/abc')).toEqual({ kind: 'none' });
    expect(day('somewhere for lunch')).toEqual({ kind: 'none' });
  });

  it('"3 days" and "a day trip" are not day references', () => {
    expect(day('we have 3 days left')).toEqual({ kind: 'none' });
    expect(day('a day trip to the coast')).toEqual({ kind: 'none' });
  });

  it('two different days → ambiguous', () => {
    expect(day('day 2 or day 4')).toEqual({ kind: 'ambiguous' });
    expect(day('day 3, Nov 16')).toEqual({ kind: 'ambiguous' });
  });

  it('numeric dates are not read: 11/12 is two different days in two countries', () => {
    expect(day('on 11/12')).toEqual({ kind: 'none' });
    expect(day('14/11')).toEqual({ kind: 'none' });
  });

  it('a date form on a trip with no start date → no_start', () => {
    expect(day('tomorrow', { ...FRAME, tripStartISO: null })).toEqual({ kind: 'no_start' });
    expect(day('day 3 tomorrow', { ...FRAME, tripStartISO: null })).toEqual({ kind: 'ambiguous' });
    // A day number needs no start date.
    expect(day('day 3', { ...FRAME, tripStartISO: null })).toEqual({ kind: 'day_number', day: 3, inRange: true });
  });

  it('a day past the end is reported, flagged out of range', () => {
    expect(day('day 9')).toEqual({ kind: 'day_number', day: 9, inRange: false });
    expect(day('Nov 30')).toEqual({ kind: 'date', day: 19, inRange: false });
  });

  it('today, before the trip starts, is day 0: out of range', () => {
    expect(day('today')).toEqual({ kind: 'relative', day: 0, inRange: false });
  });
});

describe('dates are calendar maths, not clock maths', () => {
  it('a year boundary: Dec 30 trip, "Jan 2" is day 4', () => {
    expect(day('Jan 2', { dayCount: 7, tripStartISO: '2026-12-30', todayISO: '2026-12-29' })).toEqual({
      kind: 'date',
      day: 4,
      inRange: true,
    });
  });

  it('does not depend on the host timezone', () => {
    const before = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        expect(day('Nov 14')).toEqual({ kind: 'date', day: 3, inRange: true });
        expect(day('on Saturday')).toEqual({ kind: 'weekday', day: 3, inRange: true });
      }
    } finally {
      process.env.TZ = before;
    }
  });

  it('an impossible date is ignored, not rolled over', () => {
    expect(day('Feb 31', { dayCount: 7, tripStartISO: '2026-02-27', todayISO: '2026-02-26' })).toEqual({ kind: 'none' });
  });
});
