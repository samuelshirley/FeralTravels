import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { formatPlaceLabel } = await import('./nominatim');

/**
 * The label a driver reads for a split point. The alternative it replaces is
 * Penny inventing one — trip `ab824cde` produced "Texas Panhandle" and
 * "Albuquerque area", neither of which is a place you can navigate to.
 */
describe('formatPlaceLabel', () => {
  it('prefers the town and qualifies it with the state', () => {
    expect(formatPlaceLabel('Amarillo', { city: 'Amarillo', state: 'Texas', country: 'United States' }))
      .toBe('Amarillo, Texas');
  });

  it('walks down the locality ladder: city, town, village, hamlet', () => {
    expect(formatPlaceLabel(null, { town: 'Marfa', state: 'Texas' })).toBe('Marfa, Texas');
    expect(formatPlaceLabel(null, { village: 'Terlingua', state: 'Texas' })).toBe('Terlingua, Texas');
    expect(formatPlaceLabel(null, { hamlet: 'Study Butte', state: 'Texas' })).toBe('Study Butte, Texas');
  });

  it('falls back to the country when there is no state', () => {
    expect(formatPlaceLabel(null, { city: 'Girona', country: 'Spain' })).toBe('Girona, Spain');
  });

  it('uses the top-level name when the address has no locality', () => {
    // Nominatim's answer for a remote point — the real Monument Valley probe.
    expect(formatPlaceLabel('Navajo County', { county: 'Navajo County', state: 'Arizona' }))
      .toBe('Navajo County, Arizona');
  });

  it('does not repeat itself when locality and qualifier are the same', () => {
    expect(formatPlaceLabel(null, { city: 'Singapore', country: 'Singapore' })).toBe('Singapore');
  });

  it('returns null rather than a made-up name when there is nothing usable', () => {
    // A point in the ocean. The caller must degrade, not invent.
    expect(formatPlaceLabel(null, {})).toBeNull();
    expect(formatPlaceLabel(null, null)).toBeNull();
    expect(formatPlaceLabel(undefined, undefined)).toBeNull();
  });

  it('never returns a bare region word', () => {
    // The failure mode being designed out: a label with no locality in it.
    expect(formatPlaceLabel(null, { state: 'Texas', country: 'United States' })).toBeNull();
  });
});
