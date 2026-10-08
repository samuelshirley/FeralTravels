/**
 * Tests for the add_route tool validator.
 *
 * A route is an alternative DESTINATION on a leg, so its endpoint is a pair:
 * end_lat and end_lng must both be set or both omitted. Half a coordinate
 * would save a route that points at nowhere.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, ADD_ROUTE } from './addRoute';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const LEG_ID = '00000000-0000-0000-0000-000000000001';
const parse = (input: unknown) => validator(ctx).safeParse(input);
const withData = (data: Record<string, unknown>) => parse({ leg_id: LEG_ID, data });

describe('add_route validator — end coordinates are both-or-neither', () => {
  it('accepts a route with both end_lat and end_lng', () => {
    expect(withData({ label: 'Camp A', end_lat: 44.1, end_lng: -110.5 }).success).toBe(true);
  });

  it('accepts a route with neither', () => {
    expect(withData({ label: 'Camp A' }).success).toBe(true);
  });

  it('accepts both explicitly null', () => {
    expect(withData({ label: 'Camp A', end_lat: null, end_lng: null }).success).toBe(true);
  });

  it('accepts 0/0 as a real coordinate pair (zero is not "missing")', () => {
    expect(withData({ label: 'Null Island', end_lat: 0, end_lng: 0 }).success).toBe(true);
  });

  it('rejects end_lat without end_lng and names the pair', () => {
    const result = withData({ label: 'Camp A', end_lat: 44.1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.path).toEqual(['data', 'end_lat']);
      expect(issue.message).toMatch(/both be set or both omitted/);
    }
  });

  it('rejects end_lng without end_lat', () => {
    expect(withData({ label: 'Camp A', end_lng: -110.5 }).success).toBe(false);
  });

  it('rejects one coordinate set and the other null', () => {
    expect(withData({ label: 'Camp A', end_lat: 44.1, end_lng: null }).success).toBe(false);
    expect(withData({ label: 'Camp A', end_lat: null, end_lng: -110.5 }).success).toBe(false);
  });
});

describe('add_route validator — shape', () => {
  it('accepts a fully-populated option', () => {
    const result = withData({
      label: 'Madison Campground',
      description: 'Riverside, first-come first-served',
      distance_km: 142.5,
      surface: 'gravel',
      status: 'option',
      end_lat: 44.645,
      end_lng: -110.86,
      end_name: 'Madison Campground, WY',
      end_source: 'google_places',
      end_source_url: 'https://maps.google.com/?cid=1',
      drive_time_minutes: 150,
      links: [{ type: 'google_maps', label: 'Directions', url: 'https://www.google.com/maps/dir/?api=1' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing or empty label', () => {
    expect(withData({}).success).toBe(false);
    const empty = withData({ label: '' });
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.error.issues[0].message).toBe('label is required');
  });

  it('rejects a missing or non-uuid leg_id', () => {
    expect(parse({ data: { label: 'Camp A' } }).success).toBe(false);
    expect(parse({ leg_id: '1', data: { label: 'Camp A' } }).success).toBe(false);
  });

  it('rejects a missing data object', () => {
    expect(parse({ leg_id: LEG_ID }).success).toBe(false);
  });

  it('rejects out-of-range end coordinates', () => {
    expect(withData({ label: 'A', end_lat: 95, end_lng: 10 }).success).toBe(false);
    expect(withData({ label: 'A', end_lat: 45, end_lng: 190 }).success).toBe(false);
  });

  it('rejects a non-positive or absurd distance_km', () => {
    expect(withData({ label: 'A', distance_km: 0 }).success).toBe(false);
    expect(withData({ label: 'A', distance_km: -3 }).success).toBe(false);
    expect(withData({ label: 'A', distance_km: 100_001 }).success).toBe(false);
  });

  it('rejects a drive time that is fractional, zero, or over 24h', () => {
    expect(withData({ label: 'A', drive_time_minutes: 90.5 }).success).toBe(false);
    expect(withData({ label: 'A', drive_time_minutes: 0 }).success).toBe(false);
    expect(withData({ label: 'A', drive_time_minutes: 24 * 60 + 1 }).success).toBe(false);
    expect(withData({ label: 'A', drive_time_minutes: 24 * 60 }).success).toBe(true);
  });

  it('rejects unknown enum values', () => {
    expect(withData({ label: 'A', surface: 'sand' }).success).toBe(false);
    expect(withData({ label: 'A', status: 'booked' }).success).toBe(false);
    expect(withData({ label: 'A', end_source: 'penny' }).success).toBe(false);
  });

  it('rejects a non-URL end_source_url', () => {
    expect(withData({ label: 'A', end_source_url: 'somewhere' }).success).toBe(false);
  });

  it('has no gpx_trail_id any more: GPX was removed (Sam, 2026-10-07), so Penny is not offered it and a sent one is dropped', () => {
    const data = (tool.input_schema.properties as { data: { properties: Record<string, unknown> } }).data;
    expect(data.properties).not.toHaveProperty('gpx_trail_id');
    const result = withData({ label: 'A', gpx_trail_id: '00000000-0000-0000-0000-000000000002' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.data).not.toHaveProperty('gpx_trail_id');
  });

  it('rejects malformed links', () => {
    expect(
      withData({ label: 'A', links: [{ type: 'tiktok', label: 'x', url: 'https://x.test' }] }).success
    ).toBe(false);
    expect(
      withData({ label: 'A', links: [{ type: 'gpx', label: '', url: 'https://x.test' }] }).success
    ).toBe(false);
    expect(withData({ label: 'A', links: [{ type: 'gpx', label: 'Trail', url: 'nope' }] }).success).toBe(
      false
    );
  });

  it('requires leg_id, data and data.label in the schema Anthropic sees', () => {
    expect(tool.name).toBe(ADD_ROUTE);
    expect(tool.input_schema.required).toEqual(['leg_id', 'data']);
    const data = (tool.input_schema.properties as { data: { required: string[] } }).data;
    expect(data.required).toEqual(['label']);
  });
});
