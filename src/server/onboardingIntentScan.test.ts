/**
 * Tests for the pure validation guarding the first-message intent scan. As with
 * parseStartDate, the network call isn't unit-tested (non-deterministic + needs
 * a key); the guard that keeps a hallucinated / out-of-band model response out
 * of the DB is. `validateScannedRange` re-validates the range pair the model
 * returns and enforces the load-bearing comfortable ≤ hard-max ordering.
 */
import { describe, it, expect, vi } from 'vitest';

// `server-only` throws under the jsdom test env; stub it (hoisted above imports).
vi.mock('server-only', () => ({}));

import { validateScannedRange } from './onboardingIntentScan';
import { FUEL_STOP_SPACING_KM_MIN, FUEL_STOP_SPACING_KM_MAX } from '@/lib/vehicleProfile';

describe('validateScannedRange', () => {
  it('accepts an in-band comfortable + hard-max pair', () => {
    expect(validateScannedRange(400, 600)).toEqual({
      comfortableRangeKm: 400,
      hardMaxRangeKm: 600,
    });
  });

  it('accepts comfortable alone (hard-max null)', () => {
    expect(validateScannedRange(400, null)).toEqual({
      comfortableRangeKm: 400,
      hardMaxRangeKm: null,
    });
  });

  it('drops a hard-max that sits below comfortable (range-order invariant)', () => {
    expect(validateScannedRange(500, 300)).toEqual({
      comfortableRangeKm: 500,
      hardMaxRangeKm: null,
    });
  });

  it('keeps equal comfortable and hard-max', () => {
    expect(validateScannedRange(400, 400)).toEqual({
      comfortableRangeKm: 400,
      hardMaxRangeKm: 400,
    });
  });

  it('rejects out-of-band values', () => {
    expect(validateScannedRange(FUEL_STOP_SPACING_KM_MIN - 1, null).comfortableRangeKm).toBeNull();
    expect(validateScannedRange(FUEL_STOP_SPACING_KM_MAX + 1, null).comfortableRangeKm).toBeNull();
    // hard-max out of band is dropped, comfortable stays
    expect(validateScannedRange(400, FUEL_STOP_SPACING_KM_MAX + 1)).toEqual({
      comfortableRangeKm: 400,
      hardMaxRangeKm: null,
    });
  });

  it('rejects non-integer / non-number / junk', () => {
    expect(validateScannedRange(400.5, null).comfortableRangeKm).toBeNull();
    expect(validateScannedRange('400', null).comfortableRangeKm).toBeNull();
    expect(validateScannedRange(null, null)).toEqual({
      comfortableRangeKm: null,
      hardMaxRangeKm: null,
    });
    expect(validateScannedRange(undefined, undefined)).toEqual({
      comfortableRangeKm: null,
      hardMaxRangeKm: null,
    });
    expect(validateScannedRange(NaN, NaN)).toEqual({
      comfortableRangeKm: null,
      hardMaxRangeKm: null,
    });
  });

  it('accepts the in-band boundary values', () => {
    expect(validateScannedRange(FUEL_STOP_SPACING_KM_MIN, FUEL_STOP_SPACING_KM_MAX)).toEqual({
      comfortableRangeKm: FUEL_STOP_SPACING_KM_MIN,
      hardMaxRangeKm: FUEL_STOP_SPACING_KM_MAX,
    });
  });
});
