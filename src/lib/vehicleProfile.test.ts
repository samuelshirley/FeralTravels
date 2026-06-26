import { describe, expect, it } from 'vitest';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
  buildVehicleProfileQuestions,
  coerceVehicleProfileValue,
  vehicleMeetsFuelPlanningMinimum,
  vehicleProfileRequiredCompletion,
  validateVehicleProfileDraftForSave,
  type VehicleProfileDraftInput,
} from '@/lib/vehicleProfile';

function baseDraft(over: Partial<VehicleProfileDraftInput> = {}): VehicleProfileDraftInput {
  return {
    name: 'V',
    comfortable_range_km: 400,
    hard_max_range_km: null,
    travel_style: 'road_tripper',
    max_consecutive_drive_days: 3,
    rest_days_after_driving: 1,
    dump_station_interval_days: null,
    dump_station_tracking_enabled: false,
    ...over,
  };
}

describe('vehicleProfile bounds', () => {
  it('rejects refill spacing outside km band', () => {
    const q = buildVehicleProfileQuestions('metric').find((x) => x.key === 'comfortable_range_km');
    expect(q).toBeDefined();
    expect(() => coerceVehicleProfileValue(q!, FUEL_STOP_SPACING_KM_MIN - 1)).toThrow(/≥/);
    expect(() => coerceVehicleProfileValue(q!, FUEL_STOP_SPACING_KM_MAX + 1)).toThrow(/≤/);
    expect(coerceVehicleProfileValue(q!, 400)).toBe(400);
  });

  it('caps consecutive drive days at MAX_CONSECUTIVE_DRIVE_DAYS_CAP', () => {
    const q = buildVehicleProfileQuestions('metric').find((x) => x.key === 'max_consecutive_drive_days');
    expect(q?.max).toBe(MAX_CONSECUTIVE_DRIVE_DAYS_CAP);
    expect(() => coerceVehicleProfileValue(q!, MAX_CONSECUTIVE_DRIVE_DAYS_CAP + 1)).toThrow(/≤/);
  });

  it('vehicleMeetsFuelPlanningMinimum enforces km window', () => {
    expect(vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: 199 })).toBe(false);
    expect(vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: 200 })).toBe(true);
    expect(vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: 1500 })).toBe(true);
    expect(vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: 1501 })).toBe(false);
  });

  it('vehicleProfileRequiredCompletion excludes water when tracking off', () => {
    const comp = vehicleProfileRequiredCompletion({
      name: 'V',
      comfortable_range_km: 400,
      travel_style: 'road_tripper',
      max_consecutive_drive_days: 3,
      rest_days_after_driving: 1,
      dump_station_tracking_enabled: false,
      dump_station_interval_days: null,
    });
    // 5 driving fields: name, comfortable_range_km, travel_style,
    // max_consecutive_drive_days, rest_days_after_driving (water excluded)
    expect(comp.total).toBe(5);
    expect(comp.filled).toBe(5);
  });

  it('hard_max_range_km is bounded by the same km window as comfortable', () => {
    const q = buildVehicleProfileQuestions('metric').find((x) => x.key === 'hard_max_range_km');
    expect(q).toBeDefined();
    expect(q!.optional).toBe(true);
    expect(() => coerceVehicleProfileValue(q!, FUEL_STOP_SPACING_KM_MIN - 1)).toThrow(/≥/);
    expect(() => coerceVehicleProfileValue(q!, FUEL_STOP_SPACING_KM_MAX + 1)).toThrow(/≤/);
    // Optional + empty → null (onboarding/Settings default it to comfortable).
    expect(coerceVehicleProfileValue(q!, '')).toBeNull();
  });
});

describe('hard-max range invariants', () => {
  it('defaults hard_max to comfortable when omitted (the one safe fallback)', () => {
    const res = validateVehicleProfileDraftForSave(baseDraft({ hard_max_range_km: null }), 'metric');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.comfortable_range_km).toBe(400);
      expect(res.payload.hard_max_range_km).toBe(400);
    }
  });

  it('keeps an explicit hard_max at or above comfortable', () => {
    const res = validateVehicleProfileDraftForSave(
      baseDraft({ comfortable_range_km: 400, hard_max_range_km: 550 }),
      'metric'
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload.hard_max_range_km).toBe(550);
  });

  it('rejects a hard_max below comfortable', () => {
    const res = validateVehicleProfileDraftForSave(
      baseDraft({ comfortable_range_km: 500, hard_max_range_km: 400 }),
      'metric'
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/further/i);
  });
});
