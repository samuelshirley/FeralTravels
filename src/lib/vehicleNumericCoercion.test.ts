import { describe, expect, it } from 'vitest';
import { vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';
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

describe('vehicle fuel-planning minimum after coercion helpers', () => {
  it('rejects a stringly-typed fuel range (wrong shape)', () => {
    const row = {
      name: 'Van',
      range_km: '400',
    } as unknown as Record<string, unknown>;
    expect(vehicleMeetsFuelPlanningMinimum(row)).toBe(false);
  });

  it('coercion makes a Postgres-string numeric fuel-plannable like a real JS number', () => {
    const row = {
      name: 'Van',
      range_km: coerceOptionalInt('450'),
    };
    expect(vehicleMeetsFuelPlanningMinimum(row)).toBe(true);
  });
});
