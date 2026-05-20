import { describe, expect, it } from 'vitest';
import { vehicleIsCompleteForRemediation } from '@/lib/vehicleProfile';
import { coerceOptionalFiniteNumber, coerceOptionalInt } from '@/lib/vehicleNumericCoercion';

describe('coerceOptionalFiniteNumber', () => {
  it('returns null for empty and invalid', () => {
    expect(coerceOptionalFiniteNumber(null)).toBeNull();
    expect(coerceOptionalFiniteNumber(undefined)).toBeNull();
    expect(coerceOptionalFiniteNumber('')).toBeNull();
    expect(coerceOptionalFiniteNumber('  ')).toBeNull();
    expect(coerceOptionalFiniteNumber('x')).toBeNull();
    expect(coerceOptionalFiniteNumber(Infinity)).toBeNull();
    expect(coerceOptionalFiniteNumber(Number.NaN)).toBeNull();
  });

  it('passes through finite numbers', () => {
    expect(coerceOptionalFiniteNumber(6)).toBe(6);
    expect(coerceOptionalFiniteNumber(6.5)).toBe(6.5);
  });

  it('parses numeric strings', () => {
    expect(coerceOptionalFiniteNumber('  6.25 ')).toBe(6.25);
    expect(coerceOptionalFiniteNumber('-2')).toBe(-2);
  });
});

describe('coerceOptionalInt', () => {
  it('returns null for empty and invalid', () => {
    expect(coerceOptionalInt(null)).toBeNull();
    expect(coerceOptionalInt(Number.NaN)).toBeNull();
    expect(coerceOptionalInt('oops')).toBeNull();
  });

  it('rounds finite numbers to integers', () => {
    expect(coerceOptionalInt(400)).toBe(400);
    expect(coerceOptionalInt(399.6)).toBe(400);
    expect(coerceOptionalInt('801')).toBe(801);
  });
});

describe('vehicle completeness after coercion helpers', () => {
  it('vehicleIsCompleteForRemediation rejects stringly-typed numbers (wrong shape)', () => {
    const row = {
      name: 'Van',
      refill_distance_km: '400',
      max_drive_hours_per_day: 6,
      max_drive_hours_per_week: 30,
      max_consecutive_drive_days: 3,
      dump_station_tracking_enabled: false,
      dump_station_interval_days: null,
    } as unknown as Record<string, unknown>;
    expect(vehicleIsCompleteForRemediation(row)).toBe(false);
  });

  it('coercion makes Postgres-string numerics completeness-checkable like real JS numbers', () => {
    const row = {
      name: 'Van',
      refill_distance_km: coerceOptionalInt('450'),
      max_drive_hours_per_day: coerceOptionalFiniteNumber('6'),
      max_drive_hours_per_week: coerceOptionalFiniteNumber('30'),
      max_consecutive_drive_days: coerceOptionalInt('3'),
      dump_station_tracking_enabled: false,
      dump_station_interval_days: null,
    };
    expect(vehicleIsCompleteForRemediation(row)).toBe(true);
  });
});
