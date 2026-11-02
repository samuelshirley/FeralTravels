import { describe, expect, it } from 'vitest';
import { SAME_PLACE_KM, dayStartMarkers, formatDayLabel } from './mapDayMarkers';

const leg = (id: string, lat: number | null, lng: number | null) => ({ id, start_lat: lat, start_lng: lng });

describe('formatDayLabel', () => {
  it.each([
    [[4], '4'],
    [[2, 3], '2–3'],
    [[2, 9], '2, 9'],
    [[1, 2, 3, 7], '1–3, 7'],
    [[9, 2, 3], '2–3, 9'],
  ])('%j -> %s', (days, label) => {
    expect(formatDayLabel(days)).toBe(label);
  });
});

describe('dayStartMarkers', () => {
  it('numbers days by their position, the way the itinerary lists them', () => {
    const markers = dayStartMarkers([leg('a', 41.98, 2.82), leg('b', 42.6, 0.0), leg('c', 43.26, -2.93)]);
    expect(markers.map((m) => m.label)).toEqual(['1', '2', '3']);
    expect(markers.map((m) => m.legIds)).toEqual([['a'], ['b'], ['c']]);
  });

  it('a base day shares one marker with the day that starts from the same place (no hidden number)', () => {
    // Day 1 Girona -> Ordesa; day 2 base day at Ordesa; day 3 leaves Ordesa.
    const ordesa: [number, number] = [42.6488, -0.0573];
    const markers = dayStartMarkers([
      leg('d1', 41.9794, 2.8214),
      leg('d2', ...ordesa),
      leg('d3', ordesa[0] + 0.0005, ordesa[1]), // ~55 m away: the same place
      leg('d4', 43.2627, -2.9253),
    ]);
    expect(markers.map((m) => m.label)).toEqual(['1', '2–3', '4']);
    expect(markers[1].legIds).toEqual(['d2', 'd3']);
    expect(markers[1].key).toBe('d2');
  });

  it('a place left and returned to later lists both days', () => {
    const markers = dayStartMarkers([leg('a', 10, 10), leg('b', 20, 20), leg('c', 10, 10)]);
    expect(markers.map((m) => m.label)).toEqual(['1, 3', '2']);
  });

  it(`starts more than ${SAME_PLACE_KM} km apart are separate markers`, () => {
    const markers = dayStartMarkers([leg('a', 42, 2), leg('b', 42.01, 2)]); // ~1.1 km
    expect(markers).toHaveLength(2);
  });

  it('a day with no start coordinate is skipped without renumbering the rest', () => {
    const markers = dayStartMarkers([leg('a', 1, 1), leg('b', null, null), leg('c', 3, 3)]);
    expect(markers.map((m) => m.label)).toEqual(['1', '3']);
  });

  it('no legs, no markers', () => {
    expect(dayStartMarkers([])).toEqual([]);
  });
});
