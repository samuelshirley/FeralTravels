/**
 * Tests for the update_stop tool validator.
 *
 * The load-bearing invariant: Penny may NEVER write stop_type 'fuel'. Fuel rows
 * come only from Finn (plan_fuel_stops), which attaches a real located station;
 * converting a hand-authored stop into a fuel stop would mint a "station" that
 * points at nothing. The only settable stop_type is 'other' — to touch one of
 * Finn's fuel stops she omits stop_type and edits the other fields.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, UPDATE_STOP } from './updateStop';
import type { PennyContext } from '@/lib/penny/context';

const ctx = { legs: [] } as unknown as PennyContext;
const STOP_ID = '00000000-0000-0000-0000-000000000001';

const parse = (input: unknown) => validator(ctx).safeParse(input);

describe('update_stop validator — the fuel lock', () => {
  it('rejects stop_type "fuel" (only Finn mints fuel stops)', () => {
    expect(parse({ stop_id: STOP_ID, data: { stop_type: 'fuel' } }).success).toBe(false);
  });

  it('rejects stop_type "fuel" even alongside otherwise-valid fields', () => {
    const result = parse({
      stop_id: STOP_ID,
      data: { stop_type: 'fuel', name: 'Circle K', lat: 60, lng: 10, status: 'selected' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'data.stop_type')).toBe(true);
    }
  });

  it('rejects any stop_type outside the two-type model', () => {
    for (const t of ['campground', 'grocery', 'FUEL', '']) {
      expect(parse({ stop_id: STOP_ID, data: { stop_type: t } }).success).toBe(false);
    }
  });

  it('accepts stop_type "other"', () => {
    expect(parse({ stop_id: STOP_ID, data: { stop_type: 'other' } }).success).toBe(true);
  });

  it('accepts an update that omits stop_type (how a fuel stop gets selected)', () => {
    const result = parse({ stop_id: STOP_ID, data: { status: 'selected' } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.data.stop_type).toBeUndefined();
  });

  it('accepts stop_type null (nullish — treated as "not changing it")', () => {
    expect(parse({ stop_id: STOP_ID, data: { stop_type: null } }).success).toBe(true);
  });

  it('advertises only "other" in the schema Anthropic sees', () => {
    const data = (tool.input_schema as {
      properties: { data: { properties: { stop_type: { enum: string[] } } } };
    }).properties.data.properties.stop_type;
    expect(data.enum).toEqual(['other']);
    expect(tool.name).toBe(UPDATE_STOP);
  });
});

describe('update_stop validator — shape', () => {
  it('accepts a full valid edit', () => {
    const result = parse({
      stop_id: STOP_ID,
      data: {
        stop_type: 'other',
        name: 'Trollstigen viewpoint',
        lat: 62.456,
        lng: 7.671,
        distance_from_start_km: 0,
        notes: 'Park on the left',
        status: 'dismissed',
        fuel_type: 'diesel',
        fuel_amount_l: 40,
        source: 'user',
        source_url: 'https://maps.google.com/?q=62.456,7.671',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty data object (no-op is not a schema error)', () => {
    expect(parse({ stop_id: STOP_ID, data: {} }).success).toBe(true);
  });

  it('rejects a missing or non-uuid stop_id', () => {
    expect(parse({ data: { status: 'selected' } }).success).toBe(false);
    expect(parse({ stop_id: '3', data: { status: 'selected' } }).success).toBe(false);
    expect(parse({ stop_id: 3, data: { status: 'selected' } }).success).toBe(false);
  });

  it('rejects a missing data object', () => {
    expect(parse({ stop_id: STOP_ID }).success).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    expect(parse({ stop_id: STOP_ID, data: { lat: 91 } }).success).toBe(false);
    expect(parse({ stop_id: STOP_ID, data: { lat: -91 } }).success).toBe(false);
    expect(parse({ stop_id: STOP_ID, data: { lng: 181 } }).success).toBe(false);
    expect(parse({ stop_id: STOP_ID, data: { lng: -181 } }).success).toBe(false);
  });

  it('rejects coordinates sent as strings', () => {
    expect(parse({ stop_id: STOP_ID, data: { lat: '62.4' } }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(parse({ stop_id: STOP_ID, data: { name: '' } }).success).toBe(false);
  });

  it('rejects a negative distance_from_start_km', () => {
    expect(parse({ stop_id: STOP_ID, data: { distance_from_start_km: -1 } }).success).toBe(false);
  });

  it('rejects unknown enum values for status, fuel_type and source', () => {
    expect(parse({ stop_id: STOP_ID, data: { status: 'booked' } }).success).toBe(false);
    expect(parse({ stop_id: STOP_ID, data: { fuel_type: 'electric' } }).success).toBe(false);
    expect(parse({ stop_id: STOP_ID, data: { source: 'finn' } }).success).toBe(false);
  });

  it('rejects a zero or negative fuel_amount_l', () => {
    expect(parse({ stop_id: STOP_ID, data: { fuel_amount_l: 0 } }).success).toBe(false);
    expect(parse({ stop_id: STOP_ID, data: { fuel_amount_l: -5 } }).success).toBe(false);
  });

  it('rejects a source_url that is not a URL', () => {
    expect(parse({ stop_id: STOP_ID, data: { source_url: 'not a url' } }).success).toBe(false);
  });

  it('strips unknown fields rather than passing them through', () => {
    const result = parse({ stop_id: STOP_ID, data: { status: 'selected', leg_id: STOP_ID } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.data).not.toHaveProperty('leg_id');
  });
});
