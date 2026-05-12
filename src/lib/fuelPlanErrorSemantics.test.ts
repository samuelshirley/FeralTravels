import { describe, expect, it } from 'vitest';
import { classifyFuelPlanError } from '@/lib/fuelPlanErrorSemantics';

describe('classifyFuelPlanError', () => {
  it('detects missing vehicle profile', () => {
    expect(
      classifyFuelPlanError(
        'Vehicle is missing a refill distance. Open Settings → Vehicle profile.'
      )
    ).toBe('user_vehicle_profile');
    expect(classifyFuelPlanError('No vehicle on file for user')).toBe('user_vehicle_profile');
  });

  it('detects platform key issues', () => {
    expect(classifyFuelPlanError('Missing Google Maps API key for server Places calls.')).toBe(
      'platform_config'
    );
  });

  it('defaults to unknown', () => {
    expect(classifyFuelPlanError(null)).toBe('unknown');
    expect(classifyFuelPlanError('Unexpected planner failure')).toBe('unknown');
  });
});
