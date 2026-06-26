import { describe, expect, it } from 'vitest';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  buildVehicleProfileQuestions,
  coerceVehicleProfileValue,
  vehicleMeetsFuelPlanningMinimum,
  vehicleProfileRequiredCompletion,
  validateVehicleProfileDraftForSave,
  validateComfortableKm,
  type VehicleProfileDraftInput,
} from '@/lib/vehicleProfile';

function baseDraft(over: Partial<VehicleProfileDraftInput> = {}): VehicleProfileDraftInput {
  return {
    name: 'V',
    comfortable_range_km: 400,
    hard_max_range_km: null,
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

  it('onboarding only asks name, comfortable range, and hard-max range', () => {
    const keys = buildVehicleProfileQuestions('metric').map((q) => q.key);
    expect(keys).toEqual(['name', 'comfortable_range_km', 'hard_max_range_km']);
  });

  it('vehicleMeetsFuelPlanningMinimum enforces km window', () => {
    expect(vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: 199 })).toBe(false);
    expect(vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: 200 })).toBe(true);
    expect(vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: 1500 })).toBe(true);
    expect(vehicleMeetsFuelPlanningMinimum({ comfortable_range_km: 1501 })).toBe(false);
  });

  it('vehicleProfileRequiredCompletion counts name + comfortable range (hard-max excluded)', () => {
    const comp = vehicleProfileRequiredCompletion({
      name: 'V',
      comfortable_range_km: 400,
    });
    // MVP required fields: name + comfortable_range_km. hard_max_range_km is
    // optional (safe-defaults to comfortable) so it's excluded from the count.
    expect(comp.total).toBe(2);
    expect(comp.filled).toBe(2);
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

describe('validateComfortableKm (range-help estimate guard)', () => {
  it('accepts whole numbers inside the band', () => {
    expect(validateComfortableKm(200)).toBe(200);
    expect(validateComfortableKm(500)).toBe(500);
    expect(validateComfortableKm(1500)).toBe(1500);
  });

  it('rejects out-of-band, non-integer, and non-number values', () => {
    expect(validateComfortableKm(199)).toBeNull();
    expect(validateComfortableKm(1501)).toBeNull();
    expect(validateComfortableKm(450.5)).toBeNull();
    expect(validateComfortableKm('500')).toBeNull();
    expect(validateComfortableKm(null)).toBeNull();
    expect(validateComfortableKm(NaN)).toBeNull();
  });
});
