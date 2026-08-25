import { describe, expect, it } from 'vitest';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  buildVehicleProfileQuestions,
  coerceVehicleProfileValue,
  vehicleMeetsFuelPlanningMinimum,
  vehicleProfileRequiredCompletion,
  validateVehicleProfileDraftForSave,
  validateRangeKm,
  type VehicleProfileDraftInput,
} from '@/lib/vehicleProfile';

function baseDraft(over: Partial<VehicleProfileDraftInput> = {}): VehicleProfileDraftInput {
  return {
    name: 'V',
    range_km: 400,
    ...over,
  };
}

describe('vehicleProfile bounds', () => {
  it('rejects refill spacing outside km band', () => {
    const q = buildVehicleProfileQuestions('metric').find((x) => x.key === 'range_km');
    expect(q).toBeDefined();
    expect(() => coerceVehicleProfileValue(q!, FUEL_STOP_SPACING_KM_MIN - 1)).toThrow(/≥/);
    expect(() => coerceVehicleProfileValue(q!, FUEL_STOP_SPACING_KM_MAX + 1)).toThrow(/≤/);
    expect(coerceVehicleProfileValue(q!, 400)).toBe(400);
  });

  it('onboarding only asks name and fuel range', () => {
    const keys = buildVehicleProfileQuestions('metric').map((q) => q.key);
    expect(keys).toEqual(['name', 'range_km']);
  });

  it('vehicleMeetsFuelPlanningMinimum enforces km window', () => {
    expect(vehicleMeetsFuelPlanningMinimum({ range_km: 199 })).toBe(false);
    expect(vehicleMeetsFuelPlanningMinimum({ range_km: 200 })).toBe(true);
    expect(vehicleMeetsFuelPlanningMinimum({ range_km: 1500 })).toBe(true);
    expect(vehicleMeetsFuelPlanningMinimum({ range_km: 1501 })).toBe(false);
  });

  it('vehicleProfileRequiredCompletion counts name + fuel range', () => {
    const comp = vehicleProfileRequiredCompletion({
      name: 'V',
      range_km: 400,
    });
    expect(comp.total).toBe(2);
    expect(comp.filled).toBe(2);
  });
});

describe('validateVehicleProfileDraftForSave', () => {
  it('produces an API-ready payload from a valid draft', () => {
    const res = validateVehicleProfileDraftForSave(baseDraft(), 'metric');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.name).toBe('V');
      expect(res.payload.range_km).toBe(400);
    }
  });

  it('rejects a draft with no fuel range', () => {
    const res = validateVehicleProfileDraftForSave(
      baseDraft({ range_km: null }),
      'metric'
    );
    expect(res.ok).toBe(false);
  });
});

describe('validateRangeKm (range-help estimate guard)', () => {
  it('accepts whole numbers inside the band', () => {
    expect(validateRangeKm(200)).toBe(200);
    expect(validateRangeKm(500)).toBe(500);
    expect(validateRangeKm(1500)).toBe(1500);
  });

  it('rejects out-of-band, non-integer, and non-number values', () => {
    expect(validateRangeKm(199)).toBeNull();
    expect(validateRangeKm(1501)).toBeNull();
    expect(validateRangeKm(450.5)).toBeNull();
    expect(validateRangeKm('500')).toBeNull();
    expect(validateRangeKm(null)).toBeNull();
    expect(validateRangeKm(NaN)).toBeNull();
  });
});
