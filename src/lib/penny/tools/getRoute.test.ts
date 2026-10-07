/**
 * Tests for the get_route tool validator.
 *
 * place_id is Google's opaque handle: bounded in length and otherwise never
 * parsed, so a real id is never rejected for its shape. Waypoints are capped
 * at 25 (Directions' own ceiling). The validator is pure; no Directions call
 * happens here.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, GET_ROUTE } from './getRoute';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const parse = (input: unknown) => validator(ctx).safeParse(input);

const ENDS = {
  origin_lat: 41.98,
  origin_lng: 2.82,
  destination_lat: 45.9,
  destination_lng: 6.13,
};

describe('get_route validator', () => {
  it('accepts origin and destination coordinates alone', () => {
    expect(parse(ENDS).success).toBe(true);
  });

  it('accepts every optional field', () => {
    const result = parse({
      ...ENDS,
      origin_name: 'Girona',
      destination_name: 'Annecy',
      origin_place_id: 'ChIJRRrTHsPNuhIRQMqjIeD6AAM',
      destination_place_id: 'ChIJ-Ugt4Q2Ki0cRS9I4QfQo1Yo',
      avoid: ['tolls', 'ferries'],
      waypoints: [{ lat: 44.08, lng: 3.02, name: 'Millau Viaduct', place_id: 'ChIJabc' }],
    });
    expect(result.success).toBe(true);
  });

  it('forwards a place_id untouched, whatever its shape', () => {
    const odd = 'EiJSdWUgZGUgbGEgUGFpeCwgUGFyaXMsIEZyYW5jZSIuKiwKFAoS';
    const result = parse({ ...ENDS, origin_place_id: odd });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.origin_place_id).toBe(odd);
  });

  it('rejects an empty or over-long place_id', () => {
    expect(parse({ ...ENDS, origin_place_id: '' }).success).toBe(false);
    expect(parse({ ...ENDS, destination_place_id: 'x'.repeat(301) }).success).toBe(false);
    expect(parse({ ...ENDS, destination_place_id: 'x'.repeat(300) }).success).toBe(true);
  });

  it('rejects each missing endpoint coordinate', () => {
    for (const key of Object.keys(ENDS) as (keyof typeof ENDS)[]) {
      const input: Record<string, number> = { ...ENDS };
      delete input[key];
      expect(parse(input).success, `missing ${key}`).toBe(false);
    }
  });

  it('rejects out-of-range or string coordinates', () => {
    expect(parse({ ...ENDS, origin_lat: 90.5 }).success).toBe(false);
    expect(parse({ ...ENDS, destination_lng: -180.5 }).success).toBe(false);
    expect(parse({ ...ENDS, origin_lat: '41.98' }).success).toBe(false);
  });

  it('rejects an unknown avoid flag', () => {
    expect(parse({ ...ENDS, avoid: ['gravel'] }).success).toBe(false);
  });

  it('accepts 25 waypoints and rejects 26', () => {
    const wp = { lat: 44, lng: 3 };
    expect(parse({ ...ENDS, waypoints: Array.from({ length: 25 }, () => wp) }).success).toBe(true);
    expect(parse({ ...ENDS, waypoints: Array.from({ length: 26 }, () => wp) }).success).toBe(false);
  });

  it('rejects a waypoint without coordinates or out of range', () => {
    expect(parse({ ...ENDS, waypoints: [{ name: 'Millau' }] }).success).toBe(false);
    expect(parse({ ...ENDS, waypoints: [{ lat: 44 }] }).success).toBe(false);
    expect(parse({ ...ENDS, waypoints: [{ lat: 100, lng: 3 }] }).success).toBe(false);
    expect(parse({ ...ENDS, waypoints: [{ lat: 44, lng: 3, place_id: '' }] }).success).toBe(false);
  });

  it('requires the four endpoint coordinates in the schema Anthropic sees', () => {
    expect(tool.name).toBe(GET_ROUTE);
    expect(tool.input_schema.required).toEqual([
      'origin_lat',
      'origin_lng',
      'destination_lat',
      'destination_lng',
    ]);
  });
});
