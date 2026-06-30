import { describe, it, expect } from 'vitest';
import { clusterPixels, type PixelPoint } from './mapClustering';

describe('clusterPixels', () => {
  it('returns one group per point when points are far apart', () => {
    const pts: PixelPoint[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1000, y: 1000 },
      { id: 'c', x: 5000, y: 200 },
    ];
    const groups = clusterPixels(pts, 64);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.ids.length === 1)).toBe(true);
  });

  it('merges points that fall in the same cell', () => {
    const pts: PixelPoint[] = [
      { id: 'a', x: 10, y: 10 },
      { id: 'b', x: 20, y: 20 }, // same 64px cell as a
      { id: 'c', x: 30, y: 5 }, // same cell too
    ];
    const groups = clusterPixels(pts, 64);
    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toEqual(['a', 'b', 'c']);
  });

  it('separates points that straddle a cell boundary', () => {
    const pts: PixelPoint[] = [
      { id: 'a', x: 63, y: 0 }, // cell 0
      { id: 'b', x: 65, y: 0 }, // cell 1
    ];
    const groups = clusterPixels(pts, 64);
    expect(groups).toHaveLength(2);
  });

  it('re-resolves into singletons as the cell shrinks (zoom-in analogue)', () => {
    const pts: PixelPoint[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 40, y: 0 },
    ];
    expect(clusterPixels(pts, 64)).toHaveLength(1); // zoomed out → merged
    expect(clusterPixels(pts, 16)).toHaveLength(2); // zoomed in → split
  });

  it('disables clustering for a non-positive cell size', () => {
    const pts: PixelPoint[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 1 },
    ];
    const groups = clusterPixels(pts, 0);
    expect(groups).toHaveLength(2);
  });

  it('preserves input order across and within groups (stable identity)', () => {
    const pts: PixelPoint[] = [
      { id: 'first', x: 0, y: 0 },
      { id: 'far', x: 9999, y: 9999 },
      { id: 'second', x: 5, y: 5 }, // joins "first" cell, but appears after "far"
    ];
    const groups = clusterPixels(pts, 64);
    // "first" cell was seen before "far" cell → group order follows first-seen.
    expect(groups[0].ids).toEqual(['first', 'second']);
    expect(groups[1].ids).toEqual(['far']);
  });

  it('handles an empty input', () => {
    expect(clusterPixels([], 64)).toEqual([]);
  });
});
