/**
 * Tests for the update_vehicle tool validator.
 *
 * The load-bearing invariant: Penny can NOT write the vehicle's fuel-range
 * safety numbers (comfortable_range_km / hard_max_range_km) from chat. Those
 * are set only in onboarding and Settings. The bug this locks out: "I'll need
 * to get fuel within 250km of tomorrow's drive" is a fuel REQUEST (→ Finn via
 * plan_fuel_stops), but Penny pattern-matched the distance as a range
 * preference and silently rewrote comfortable_range_km. The schema must make
 * that unreachable — fuel_type is the only settable field.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool } from './updateVehicle';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as unknown as PennyContext;

describe('update_vehicle validator', () => {
  it('rejects comfortable_range_km — range is onboarding/Settings-only', () => {
    const result = validator(ctx).safeParse({
      data: { comfortable_range_km: 250 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects hard_max_range_km — range is onboarding/Settings-only', () => {
    const result = validator(ctx).safeParse({
      data: { hard_max_range_km: 600 },
    });
    expect(result.success).toBe(false);
  });

  it('strips range fields even when smuggled alongside fuel_type', () => {
    const result = validator(ctx).safeParse({
      data: { fuel_type: 'diesel', comfortable_range_km: 250 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.data).toEqual({ fuel_type: 'diesel' });
    }
  });

  it('accepts fuel_type', () => {
    const result = validator(ctx).safeParse({
      data: { fuel_type: 'petrol' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty data object (fuel_type required)', () => {
    const result = validator(ctx).safeParse({ data: {} });
    expect(result.success).toBe(false);
  });

  it('tool schema advertises no range fields to the model', () => {
    const schemaProps = tool.input_schema.properties as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    const props = schemaProps.data.properties;
    expect(Object.keys(props ?? {})).toEqual(['fuel_type']);
  });
});
