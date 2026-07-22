import { describe, it, expect } from 'vitest';
import { encodePolyline, decodePolyline } from './polyline';

describe('encodePolyline', () => {
  it('round-trips through decodePolyline within 1e-5 precision', () => {
    const pts = [
      { lat: 59.334, lng: 18.063 },
      { lat: 59.9139, lng: 10.7522 },
      { lat: 55.6761, lng: 12.5683 },
    ];
    const decoded = decodePolyline(encodePolyline(pts));
    expect(decoded).toHaveLength(pts.length);
    decoded.forEach((d, i) => {
      expect(d.lat).toBeCloseTo(pts[i].lat, 4);
      expect(d.lng).toBeCloseTo(pts[i].lng, 4);
    });
  });

  it('matches Google reference encoding for the canonical example', () => {
    // From Google's polyline algorithm docs.
    const pts = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });
});
