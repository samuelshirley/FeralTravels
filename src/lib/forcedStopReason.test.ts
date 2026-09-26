import { describe, it, expect } from 'vitest';
import { forcedStopLine } from './forcedStopReason';
import type { ForcedStopReason } from '@/types/trip';

const far: ForcedStopReason = { kind: 'next_fuel_far', gap_km: 412 };
const nextDay: ForcedStopReason = { kind: 'next_day_fuel_far', gap_km: 412 };

describe('forcedStopLine', () => {
  it('words the gap in km for a metric user', () => {
    expect(forcedStopLine('fuel', far, 'metric')).toBe('Top up here: next fuel is 412 km away');
  });

  it('words the gap in miles, and no km, for an imperial user', () => {
    const line = forcedStopLine('fuel', far, 'imperial');
    expect(line).toBe('Top up here: next fuel is 256 mi away'); // 412 × 0.621371 = 256.0
    expect(line).not.toMatch(/\bkm\b/);
  });

  it("says the next fuel is on the next day's drive, in km for a metric user", () => {
    expect(forcedStopLine('fuel', nextDay, 'metric')).toBe(
      "Top up here: next fuel is 412 km away, on the next day's drive"
    );
  });

  it("says the next fuel is on the next day's drive, in miles and no km, for an imperial user", () => {
    const line = forcedStopLine('fuel', nextDay, 'imperial');
    expect(line).toBe("Top up here: next fuel is 256 mi away, on the next day's drive");
    expect(line).not.toMatch(/\bkm\b/);
  });

  it('says nothing on a stop the user added, even if a reason is attached', () => {
    expect(forcedStopLine('other', far, 'metric')).toBeNull();
    expect(forcedStopLine('other', nextDay, 'metric')).toBeNull();
  });

  it('says nothing on a fuel stop Finn did not force', () => {
    expect(forcedStopLine('fuel', null, 'metric')).toBeNull();
    expect(forcedStopLine('fuel', undefined, 'imperial')).toBeNull();
  });

  it('hides a reason kind this client does not know rather than mis-wording it', () => {
    const unknown = { kind: 'road_closed', gap_km: 90 } as unknown as ForcedStopReason;
    expect(forcedStopLine('fuel', unknown, 'metric')).toBeNull();
  });

  it('hides a reason with no usable distance', () => {
    const bad = { kind: 'next_fuel_far', gap_km: Number.NaN } as ForcedStopReason;
    expect(forcedStopLine('fuel', bad, 'metric')).toBeNull();
    const badNextDay = { kind: 'next_day_fuel_far', gap_km: Number.NaN } as ForcedStopReason;
    expect(forcedStopLine('fuel', badNextDay, 'metric')).toBeNull();
  });
});
