/**
 * Tests for the update_route tool validator.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, UPDATE_ROUTE } from './updateRoute';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const ROUTE_ID = '00000000-0000-0000-0000-000000000001';
const parse = (input: unknown) => validator(ctx).safeParse(input);
const withData = (data: Record<string, unknown>) => parse({ route_id: ROUTE_ID, data });

describe('update_route validator', () => {
  it('accepts a status change (the user picked this option)', () => {
    expect(withData({ status: 'selected' }).success).toBe(true);
  });

  it('rejects end_lat without end_lng, and the reverse, naming the pair', () => {
    for (const data of [{ end_lat: 44.1 }, { end_lng: -110.5 }, { end_lat: 44.1, end_lng: null }]) {
      const result = withData(data);
      expect(result.success, JSON.stringify(data)).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/both be set or both omitted/);
        expect(result.error.issues[0].path).toEqual(['data', 'end_lat']);
      }
    }
  });

  it('accepts both end coordinates, or both cleared', () => {
    expect(withData({ end_lat: 44.1, end_lng: -110.5 }).success).toBe(true);
    expect(withData({ end_lat: null, end_lng: null }).success).toBe(true);
  });

  it('accepts an empty data object', () => {
    expect(withData({}).success).toBe(true);
  });

  it('accepts a full valid edit', () => {
    const result = withData({
      label: 'Camp B',
      description: 'Lakeside',
      distance_km: 80,
      surface: 'mix',
      status: 'dismissed',
      end_lat: 44.1,
      end_lng: -110.5,
      end_name: 'Camp B, WY',
      end_source: 'manual',
      end_source_url: 'https://example.com/camp-b',
      drive_time_minutes: 75,
      links: [{ type: 'park', label: 'NPS page', url: 'https://www.nps.gov/yell' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing or non-uuid route_id', () => {
    expect(parse({ data: { status: 'selected' } }).success).toBe(false);
    expect(parse({ route_id: 'Camp B', data: { status: 'selected' } }).success).toBe(false);
  });

  it('rejects a missing data object', () => {
    expect(parse({ route_id: ROUTE_ID }).success).toBe(false);
  });

  it('rejects an empty label', () => {
    expect(withData({ label: '' }).success).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    expect(withData({ end_lat: -90.01 }).success).toBe(false);
    expect(withData({ end_lng: 180.01 }).success).toBe(false);
  });

  it('rejects bad distance and drive time', () => {
    expect(withData({ distance_km: 0 }).success).toBe(false);
    expect(withData({ distance_km: 200_000 }).success).toBe(false);
    expect(withData({ drive_time_minutes: 1.5 }).success).toBe(false);
    expect(withData({ drive_time_minutes: 25 * 60 }).success).toBe(false);
  });

  it('rejects unknown enum values', () => {
    expect(withData({ status: 'chosen' }).success).toBe(false);
    expect(withData({ surface: 'mud' }).success).toBe(false);
    expect(withData({ end_source: 'google' }).success).toBe(false);
  });

  it('rejects a malformed link and a non-URL end_source_url', () => {
    expect(withData({ links: [{ type: 'gpx', label: 'x' }] }).success).toBe(false);
    expect(withData({ end_source_url: 'camp b' }).success).toBe(false);
  });

  it('strips fields add_route has but update_route does not (gpx_trail_id)', () => {
    const result = withData({ status: 'selected', gpx_trail_id: ROUTE_ID });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.data).not.toHaveProperty('gpx_trail_id');
  });

  it('requires route_id and data in the schema Anthropic sees', () => {
    expect(tool.name).toBe(UPDATE_ROUTE);
    expect(tool.input_schema.required).toEqual(['route_id', 'data']);
  });
});
