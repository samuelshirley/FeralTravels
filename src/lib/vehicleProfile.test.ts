import { describe, expect, it } from 'vitest';
import {
  FUEL_STOP_SPACING_KM_MAX,
  FUEL_STOP_SPACING_KM_MIN,
  MAX_CONSECUTIVE_DRIVE_DAYS_CAP,
  buildVehicleProfileQuestions,
  coerceVehicleProfileValue,
  vehicleMeetsFuelPlanningMinimum,
  vehicleProfileRequiredCompletion,
} from '@/lib/vehicleProfile';

describe('vehicleProfile bounds', () => {
  it('rejects refill spacing outside km band', () => {
    const q = buildVehicleProfileQuestions('metric').find((x) => x.key === 'refill_distance_km');
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
    expect(vehicleMeetsFuelPlanningMinimum({ refill_distance_km: 199 })).toBe(false);
    expect(vehicleMeetsFuelPlanningMinimum({ refill_distance_km: 200 })).toBe(true);
    expect(vehicleMeetsFuelPlanningMinimum({ refill_distance_km: 1500 })).toBe(true);
    expect(vehicleMeetsFuelPlanningMinimum({ refill_distance_km: 1501 })).toBe(false);
  });

  it('vehicleProfileRequiredCompletion excludes water when tracking off', () => {
    const comp = vehicleProfileRequiredCompletion({
      name: 'V',
      refill_distance_km: 400,
      max_drive_hours_per_day: 6,
      max_drive_hours_per_week: 30,
      max_consecutive_drive_days: 3,
      rest_days_after_driving: 1,
      dump_station_tracking_enabled: false,
      dump_station_interval_days: null,
    });
    // 5 driving fields: name, refill_distance_km, max_drive_hours_per_day,
    // max_consecutive_drive_days, rest_days_after_driving (water excluded)
    expect(comp.total).toBe(5);
    expect(comp.filled).toBe(5);
  });
});
