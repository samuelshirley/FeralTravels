/**
 * Tests for the pure validation guarding the first-message intent scan. As with
 * parseStartDate, the network call isn't unit-tested (non-deterministic + needs
 * a key); the guard that keeps a hallucinated / out-of-band model response out
 * of the DB is. `validateScannedRange` re-validates the range the model
 * returns.
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import {
  MAX_VEHICLE_NAME_CHARS,
  resolveScannedRangeKm,
  validateScannedOrigin,
  validateScannedRange,
  validateScannedVehicleName,
} from './onboardingIntentScan';
import { FUEL_STOP_SPACING_KM_MIN, FUEL_STOP_SPACING_KM_MAX } from '@/lib/vehicleProfile';

describe('validateScannedRange', () => {
  it('accepts an in-band range', () => {
    expect(validateScannedRange(400)).toEqual({ rangeKm: 400 });
  });

  it('rejects out-of-band values', () => {
    expect(validateScannedRange(FUEL_STOP_SPACING_KM_MIN - 1).rangeKm).toBeNull();
    expect(validateScannedRange(FUEL_STOP_SPACING_KM_MAX + 1).rangeKm).toBeNull();
  });

  it('rejects non-integer / non-number / junk', () => {
    expect(validateScannedRange(400.5).rangeKm).toBeNull();
    expect(validateScannedRange('400').rangeKm).toBeNull();
    expect(validateScannedRange(null)).toEqual({ rangeKm: null });
    expect(validateScannedRange(undefined)).toEqual({ rangeKm: null });
    expect(validateScannedRange(NaN)).toEqual({ rangeKm: null });
  });

  it('accepts the in-band boundary values', () => {
    expect(validateScannedRange(FUEL_STOP_SPACING_KM_MIN)).toEqual({
      rangeKm: FUEL_STOP_SPACING_KM_MIN,
    });
    expect(validateScannedRange(FUEL_STOP_SPACING_KM_MAX)).toEqual({
      rangeKm: FUEL_STOP_SPACING_KM_MAX,
    });
  });
});

describe('validateScannedOrigin', () => {
  it('keeps a plain place name, collapsing whitespace', () => {
    expect(validateScannedOrigin('  Paris ')).toBe('Paris');
    expect(validateScannedOrigin('Girona,\n Spain')).toBe('Girona, Spain');
  });

  it('treats anything that is not a bounded string as absent', () => {
    expect(validateScannedOrigin(null)).toBeNull();
    expect(validateScannedOrigin('')).toBeNull();
    expect(validateScannedOrigin('   ')).toBeNull();
    expect(validateScannedOrigin(42)).toBeNull();
    expect(validateScannedOrigin('x'.repeat(121))).toBeNull();
  });
});

describe('validateScannedVehicleName', () => {
  it('keeps a named vehicle, collapsing whitespace', () => {
    expect(validateScannedVehicleName(' Sprinter\n 4x4 ')).toBe('Sprinter 4x4');
  });
  it('treats non-strings, blanks and over-long names as absent', () => {
    expect(validateScannedVehicleName(null)).toBeNull();
    expect(validateScannedVehicleName('  ')).toBeNull();
    expect(validateScannedVehicleName(4)).toBeNull();
    expect(validateScannedVehicleName('x'.repeat(MAX_VEHICLE_NAME_CHARS + 1))).toBeNull();
  });
});

describe('resolveScannedRangeKm — the server converts, the model only copies', () => {
  it('km as written', () => expect(resolveScannedRangeKm(700, 'km', null)).toBe(700));
  it('miles converted', () => expect(resolveScannedRangeKm(450, 'mi', 'metric')).toBe(724));
  it('no unit follows the chosen units', () => {
    expect(resolveScannedRangeKm(450, null, 'imperial')).toBe(724);
    expect(resolveScannedRangeKm(450, null, 'metric')).toBe(450);
  });
  it('no unit and no units chosen is not guessed', () => {
    expect(resolveScannedRangeKm(450, null, null)).toBeNull();
  });
  it('out of the vehicle band, junk or a made-up unit is null', () => {
    expect(resolveScannedRangeKm(FUEL_STOP_SPACING_KM_MAX + 1, 'km', null)).toBeNull();
    expect(resolveScannedRangeKm(FUEL_STOP_SPACING_KM_MIN - 1, 'km', null)).toBeNull();
    expect(resolveScannedRangeKm('700', 'km', null)).toBeNull();
    expect(resolveScannedRangeKm(-5, 'km', null)).toBeNull();
    expect(resolveScannedRangeKm(700, 'leagues', null)).toBeNull();
  });
});
