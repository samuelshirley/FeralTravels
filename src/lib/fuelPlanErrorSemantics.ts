/** User can fix (vehicle profile, settings) vs platform/config vs unknown. */
export type FuelPlanProblemCategory = 'user_vehicle_profile' | 'platform_config' | 'unknown';

/**
 * Classify `legs.fuel_plan_error` copy so the UI can steer users to vehicle
 * setup instead of looking like a random backend failure.
 */
export function classifyFuelPlanError(message: string | null | undefined): FuelPlanProblemCategory {
  if (message == null || message.trim() === '') return 'unknown';
  const m = message.toLowerCase();

  if (
    m.includes('no vehicle on file') ||
    m.includes('vehicle is missing') ||
    m.includes('missing a refill distance') ||
    m.includes('refill distance') ||
    m.includes('vehicle profile')
  ) {
    return 'user_vehicle_profile';
  }

  if (
    m.includes('google maps api key') ||
    m.includes('places api') ||
    m.includes('go/google') ||
    m.includes('http 403') ||
    m.includes('quota') ||
    m.includes('billing')
  ) {
    return 'platform_config';
  }

  return 'unknown';
}
