import { vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';

/**
 * The vehicle rule every seeded / fixture account follows, and the real
 * vehicle they all drive.
 *
 * Lives here, next to seedDates.ts, for the same reason that file does: it is
 * fixture scaffolding that has to be readable from three places at once — the
 * fixture layer (`src/server/repos/testSupport.ts`), the guarded `/api/test/*`
 * routes, and a plain vitest spec. So it is pure: no `server-only`, no
 * database, no Next runtime. Import it; never restate the numbers.
 *
 * ── The bug this exists to prevent ──
 *
 * A seeded test account was opened in production-shaped data and every day of
 * its trip read "Finish your vehicle profile so we can plan fuel stops along
 * this leg". The trip had legs; the account owned no vehicle at all; Finn
 * bailed at the first thing it checks (`No vehicle on file for user`,
 * src/server/fuel.ts). Nothing in the app can produce that pairing — only a
 * fixture writing trip rows directly can — which is exactly why nothing in the
 * app noticed it.
 */

/**
 * Sam's real vehicle, so a fixture account is the same shape as the account
 * the product was designed against.
 *
 * Read out of the PRODUCTION `vehicles` row belonging to
 * `samuelashirley@gmail.com` on 2026-08-27 with a read-only SELECT (nothing
 * was written): `name = 'Hilux'`, `range_km = 500`, `fuel_type = NULL`,
 * `is_default = true`.
 *
 * `fuel_type` is copied as NULL rather than "corrected" to diesel. That is the
 * faithful value AND the state most real accounts are in — the column has no
 * onboarding question yet, and both `coerceFuelType` (repos/vehicles.ts) and
 * Finn's price layer already read NULL as diesel. Writing 'diesel' here would
 * make the fixtures exercise a path the typical user does not.
 */
export const HILUX_FIXTURE_VEHICLE = {
  name: 'Hilux',
  range_km: 500,
  fuel_type: null,
} as const;

/** What a fixture builder has to be able to say about the trip it just wrote. */
export interface FixtureTripState {
  /** `trips.onboarding_state` as persisted. */
  onboardingState: string;
  /** Does the trip carry any legs — i.e. has it been planned? */
  hasLegs: boolean;
  /**
   * The largest `range_km` across every vehicle the trip's OWNER holds; null
   * when they hold none.
   *
   * Deliberately the owner's vehicles and not `trips.vehicle_id`: fuel
   * planning resolves the trip's own vehicle FIRST but falls back to the
   * owner's default when the trip carries none (`resolveVehicleForTrip`,
   * src/server/fuel.ts). A trip row with a null `vehicle_id` is therefore
   * fine on its own — a user with no vehicle anywhere is not.
   */
  ownerBestRangeKm: number | null;
}

/**
 * THE INVARIANT, as one pure predicate. Returns null when the state is one the
 * app itself could have produced, or a sentence explaining why it could not.
 *
 * The rule is NOT "a trip row cannot exist without a vehicle" — `POST
 * /api/trips` takes `vehicle_id` as optional and even nulls out a default
 * vehicle that is missing its range rather than refusing (src/app/api/trips/
 * route.ts), because onboarding collects the vehicle AFTER the row exists.
 *
 * The rule is that a trip cannot be PLANNED without one. Onboarding is the
 * gate: `vehicle_new` only advances to `done` once the account owns a vehicle
 * with every profile field filled (src/server/onboarding.ts), and only a trip
 * past `done` ever reaches Penny and gets legs. So a trip carrying legs, or
 * sitting in `done`, is a trip whose owner was made to supply a vehicle Finn
 * can plan with.
 */
export function impossibleFixtureTripReason(state: FixtureTripState): string | null {
  if (vehicleMeetsFuelPlanningMinimum({ range_km: state.ownerBestRangeKm })) return null;

  const owns =
    state.ownerBestRangeKm == null
      ? 'its owner has no vehicle at all'
      : `its owner's best vehicle range (${state.ownerBestRangeKm} km) is outside the plannable band`;

  if (state.hasLegs) {
    return `trip has legs but ${owns} — Finn will fail every day of it with "No vehicle on file for user"`;
  }
  if (state.onboardingState === 'done') {
    return `trip has left onboarding (state "done") but ${owns} — onboarding cannot exit vehicle_new without one`;
  }
  return null;
}
