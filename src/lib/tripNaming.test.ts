import { describe, it, expect } from 'vitest';
import { seasonForMonth, seasonalTripName, isPlaceholderTripName } from './tripNaming';

describe('seasonForMonth (northern hemisphere)', () => {
  it('maps months to seasons', () => {
    expect(seasonForMonth(11)).toBe('Winter'); // Dec
    expect(seasonForMonth(0)).toBe('Winter'); // Jan
    expect(seasonForMonth(1)).toBe('Winter'); // Feb
    expect(seasonForMonth(2)).toBe('Spring'); // Mar
    expect(seasonForMonth(4)).toBe('Spring'); // May
    expect(seasonForMonth(5)).toBe('Summer'); // Jun
    expect(seasonForMonth(7)).toBe('Summer'); // Aug
    expect(seasonForMonth(8)).toBe('Fall'); // Sep
    expect(seasonForMonth(10)).toBe('Fall'); // Nov
  });
});

describe('seasonalTripName', () => {
  it('uses the month for a short trip (no end date)', () => {
    expect(seasonalTripName('2026-06-01')).toBe("June '26 Trip");
  });

  it('uses the month for a trip <= ~1 month, even across a month boundary', () => {
    // May 29 → June 2 (5 days) — short, named off the start month.
    expect(seasonalTripName('2026-05-29', '2026-06-02')).toBe("May '26 Trip");
  });

  it('uses the season for a trip longer than a month', () => {
    // Jun 1 → Aug 15 (~75 days) — long, named off the season.
    expect(seasonalTripName('2026-06-01', '2026-08-15')).toBe("Summer '26 Trip");
  });

  it('treats exactly 31 days as short (month), 32 days as long (season)', () => {
    expect(seasonalTripName('2026-06-01', '2026-07-02')).toBe("June '26 Trip"); // 31 days
    expect(seasonalTripName('2026-06-01', '2026-07-03')).toBe("Summer '26 Trip"); // 32 days
  });

  it('formats the year as a 2-digit suffix', () => {
    expect(seasonalTripName('2027-01-10')).toBe("January '27 Trip");
    expect(seasonalTripName('2030-12-25')).toBe("December '30 Trip");
  });

  it('returns null for an unparseable start date', () => {
    expect(seasonalTripName('not-a-date')).toBeNull();
  });

  it('ignores an unparseable end date and falls back to the month', () => {
    expect(seasonalTripName('2026-06-01', 'garbage')).toBe("June '26 Trip");
  });
});

describe('isPlaceholderTripName', () => {
  it('treats blank and auto-assigned names as placeholders', () => {
    expect(isPlaceholderTripName('')).toBe(true);
    expect(isPlaceholderTripName('   ')).toBe(true);
    expect(isPlaceholderTripName('New trip')).toBe(true);
    expect(isPlaceholderTripName('new trip')).toBe(true);
    expect(isPlaceholderTripName('New trip 2')).toBe(true);
    expect(isPlaceholderTripName('New trip 17')).toBe(true);
    expect(isPlaceholderTripName('Untitled Trip')).toBe(true);
    expect(isPlaceholderTripName(null)).toBe(true);
    expect(isPlaceholderTripName(undefined)).toBe(true);
  });

  it('treats real names (including auto-generated seasonal ones) as non-placeholders', () => {
    expect(isPlaceholderTripName("Summer '26 Trip")).toBe(false);
    expect(isPlaceholderTripName("June '26 Trip")).toBe(false);
    expect(isPlaceholderTripName('Patagonia Loop')).toBe(false);
    expect(isPlaceholderTripName('New trip to Mexico')).toBe(false); // not the bare placeholder
  });
});
