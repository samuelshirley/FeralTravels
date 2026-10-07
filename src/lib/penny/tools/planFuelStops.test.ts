/**
 * Tests for the plan_fuel_stops tool validator.
 *
 * Penny hands Finn a persisted leg id and nothing else — the stations, their
 * coordinates and the forced-stop reasons all come from the server. The schema
 * must not grow a field she could use to author fuel stops herself.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator, tool, PLAN_FUEL_STOPS } from './planFuelStops';
import type { PennyContext } from '@/lib/penny/context';

const ctx = {} as PennyContext;
const LEG_ID = '00000000-0000-0000-0000-000000000001';
const parse = (input: unknown) => validator(ctx).safeParse(input);

describe('plan_fuel_stops validator', () => {
  it('accepts a uuid leg_id', () => {
    expect(parse({ leg_id: LEG_ID }).success).toBe(true);
  });

  it('rejects a missing leg_id', () => {
    expect(parse({}).success).toBe(false);
  });

  it('rejects a sort_order / ordinal instead of the persisted id', () => {
    expect(parse({ leg_id: 1 }).success).toBe(false);
    expect(parse({ leg_id: '1' }).success).toBe(false);
    expect(parse({ leg_id: 'leg-1' }).success).toBe(false);
  });

  it('drops any Penny-authored stations or coordinates', () => {
    const result = parse({
      leg_id: LEG_ID,
      stations: [{ name: 'Shell', lat: 60, lng: 10 }],
      range_km: 200,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ leg_id: LEG_ID });
  });

  it('exposes only leg_id in the schema Anthropic sees', () => {
    expect(tool.name).toBe(PLAN_FUEL_STOPS);
    expect(tool.input_schema.required).toEqual(['leg_id']);
    expect(Object.keys(tool.input_schema.properties as Record<string, unknown>)).toEqual(['leg_id']);
  });
});
