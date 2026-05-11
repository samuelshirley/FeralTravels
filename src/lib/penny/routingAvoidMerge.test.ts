import { describe, it, expect } from 'vitest';
import {
  canonicalDirectionsAvoid,
  mergedDirectionsAvoidFromPenny,
} from './routingAvoidMerge';

describe('canonicalDirectionsAvoid', () => {
  it('dedupes and uses stable motorway–tolls–ferries ordering', () => {
    expect(canonicalDirectionsAvoid(['tolls', 'highways', 'tolls'])).toEqual(['highways', 'tolls']);
    expect(canonicalDirectionsAvoid(['ferries', 'highways'])).toEqual(['highways', 'ferries']);
  });

  it('returns empty for empty input', () => {
    expect(canonicalDirectionsAvoid([])).toEqual([]);
  });
});

describe('mergedDirectionsAvoidFromPenny', () => {
  it('defaults highways from trip preference and unions model avoids', () => {
    expect(
      mergedDirectionsAvoidFromPenny({
        tripPreferAvoidHighways: true,
        modelAvoid: ['tolls'],
      })
    ).toEqual(['highways', 'tolls']);
  });

  it('returns undefined when neither trip nor model requests avoidance', () => {
    expect(
      mergedDirectionsAvoidFromPenny({ tripPreferAvoidHighways: false, modelAvoid: undefined })
    ).toBeUndefined();
  });

  it('passes through explicit model avoids when trip pref is off', () => {
    expect(
      mergedDirectionsAvoidFromPenny({ tripPreferAvoidHighways: false, modelAvoid: ['ferries'] })
    ).toEqual(['ferries']);
  });
});
