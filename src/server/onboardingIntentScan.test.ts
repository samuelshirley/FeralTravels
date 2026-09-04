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

import { validateScannedOrigin, validateScannedRange } from './onboardingIntentScan';
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
