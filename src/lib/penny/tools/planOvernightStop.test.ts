/**
 * Tests for the plan_overnight_stop tool definition + validator. The engine
 * itself is tested under src/lib/penny/overnight/; here we just assert the
 * tool's shape and input validation behave.
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import { PLAN_OVERNIGHT_STOP, tool, validator } from './planOvernightStop';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;

describe('plan_overnight_stop tool', () => {
  it('has a stable name matching the Anthropic tool def', () => {
    expect(PLAN_OVERNIGHT_STOP).toBe('plan_overnight_stop');
    expect(tool.name).toBe(PLAN_OVERNIGHT_STOP);
    expect(tool.input_schema.required).toEqual([
      'origin_lat',
      'origin_lng',
      'destination_lat',
      'destination_lng',
    ]);
  });

  it('steers Penny to prefer adjacent-lot candidates and not invent spots', () => {
    const description = tool.description ?? '';
    expect(description).toMatch(/has_adjacent_lot/);
    expect(description.toLowerCase()).toMatch(/never invent|do not invent/);
  });

  it('accepts a valid origin/destination payload', () => {
    const parsed = validator(ctx).safeParse({
      origin_lat: 47.36,
      origin_lng: 8.53,
      destination_lat: 47.27,
      destination_lng: 11.4,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional target_km and avoid', () => {
    const parsed = validator(ctx).safeParse({
      origin_lat: 47.36,
      origin_lng: 8.53,
      destination_lat: 47.27,
      destination_lng: 11.4,
      target_km: 180,
      avoid: ['tolls'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    const parsed = validator(ctx).safeParse({
      origin_lat: 200,
      origin_lng: 8.53,
      destination_lat: 47.27,
      destination_lng: 11.4,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-positive target_km', () => {
    const parsed = validator(ctx).safeParse({
      origin_lat: 47.36,
      origin_lng: 8.53,
      destination_lat: 47.27,
      destination_lng: 11.4,
      target_km: 0,
    });
    expect(parsed.success).toBe(false);
  });
});
