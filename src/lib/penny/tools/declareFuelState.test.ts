/**
 * Tests for the declare_fuel_state tool validator.
 *
 * The declaration is the driver's statement of the fuel in the tank right now
 * — it must anchor to a real DRIVE leg on the trip and can never exceed the
 * vehicle's hard-max range (a tank cannot hold more than the ceiling; a claim
 * that it can is a range PREFERENCE, which is Settings-only).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { validator } from './declareFuelState';
import type { PennyContext } from '@/lib/penny/context';

const LEG_ID = '00000000-0000-0000-0000-000000000001';
const REST_LEG_ID = '00000000-0000-0000-0000-000000000002';

const ctx = {
  legs: [
    { id: LEG_ID, leg_type: 'drive', start_name: 'Puoltikasvaara', end_name: 'Gammelstad' },
    { id: REST_LEG_ID, leg_type: 'rest', start_name: 'Gammelstad', end_name: 'Gammelstad' },
  ],
  vehicle: { comfortable_range_km: 500, hard_max_range_km: 600 },
} as unknown as PennyContext;

describe('declare_fuel_state validator', () => {
  it('accepts a plausible declaration on a drive leg (the d0b5741b case)', () => {
    const result = validator(ctx).safeParse({ leg_id: LEG_ID, remaining_range_km: 150 });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown leg_id (not saved on this trip)', () => {
    const result = validator(ctx).safeParse({
      leg_id: '00000000-0000-0000-0000-00000000dead',
      remaining_range_km: 150,
    });
    expect(result.success).toBe(false);
  });

  it('rejects anchoring to a rest leg (tank state is about driving)', () => {
    const result = validator(ctx).safeParse({
      leg_id: REST_LEG_ID,
      remaining_range_km: 150,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a declaration above the hard-max range and points at Settings', () => {
    const result = validator(ctx).safeParse({ leg_id: LEG_ID, remaining_range_km: 700 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toMatch(/Settings/);
    }
  });

  it('accepts a declaration between comfortable and hard-max (topped up + reserve)', () => {
    const result = validator(ctx).safeParse({ leg_id: LEG_ID, remaining_range_km: 550 });
    expect(result.success).toBe(true);
  });

  it('rejects zero / negative remaining range', () => {
    expect(validator(ctx).safeParse({ leg_id: LEG_ID, remaining_range_km: 0 }).success).toBe(false);
    expect(validator(ctx).safeParse({ leg_id: LEG_ID, remaining_range_km: -50 }).success).toBe(false);
  });

  it('falls back to comfortable range as the ceiling when hard-max is unset', () => {
    const noHardMaxCtx = {
      legs: [{ id: LEG_ID, leg_type: 'drive' }],
      vehicle: { comfortable_range_km: 500, hard_max_range_km: null },
    } as unknown as PennyContext;
    expect(
      validator(noHardMaxCtx).safeParse({ leg_id: LEG_ID, remaining_range_km: 550 }).success
    ).toBe(false);
    expect(
      validator(noHardMaxCtx).safeParse({ leg_id: LEG_ID, remaining_range_km: 450 }).success
    ).toBe(true);
  });

  it('skips the ceiling check when no vehicle is on file (validated later by Finn)', () => {
    const noVehicleCtx = {
      legs: [{ id: LEG_ID, leg_type: 'drive' }],
      vehicle: null,
    } as unknown as PennyContext;
    expect(
      validator(noVehicleCtx).safeParse({ leg_id: LEG_ID, remaining_range_km: 800 }).success
    ).toBe(true);
  });
});
