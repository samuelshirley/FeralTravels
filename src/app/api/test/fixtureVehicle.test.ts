import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  HILUX_FIXTURE_VEHICLE,
  impossibleFixtureTripReason,
  type FixtureTripState,
} from './fixtureVehicle';
import { vehicleMeetsFuelPlanningMinimum } from '@/lib/vehicleProfile';

/**
 * "There is no way a user can complete a trip without a vehicle."
 *
 * That is true of the APP — onboarding will not leave `vehicle_new` until the
 * account owns a complete vehicle, and nothing gets legs before onboarding
 * hands off — and it was not true of the FIXTURES, which write trip rows
 * straight into Postgres and skip the gate entirely. A seeded account was
 * opened with a trip whose every day read "Finish your vehicle profile so we
 * can plan fuel stops along this leg".
 *
 * These tests pin the rule itself and then pin the fixture layer to it. They
 * are unit tests rather than a Playwright spec because the rule is a pure
 * predicate over four facts, and because a guard that only runs when someone
 * boots a browser is a guard that runs after the damage.
 *
 * The row-level half — that the fixtures actually SATISFY the rule against a
 * real database — is enforced at seed time by `assertFixtureTripPossible` in
 * testSupport.ts, so every e2e run checks it without a spec of its own; a
 * violation 400s `/api/test/seed` or `/api/test/trip` and reds the suite at
 * setup. The last `describe` below is what keeps that call in place.
 */

/** A planned trip belonging to an account that drives the Hilux. */
const PLANNED_WITH_HILUX: FixtureTripState = {
  onboardingState: 'done',
  hasLegs: true,
  ownerBestRangeKm: HILUX_FIXTURE_VEHICLE.range_km,
};

describe('the fixture vehicle is one the app itself would accept', () => {
  it('passes the same fuel-planning bar every real vehicle has to pass', () => {
    // If the borrowed numbers ever stopped clearing this bar, every assertion
    // below would still pass while every seeded account stayed broken.
    expect(
      vehicleMeetsFuelPlanningMinimum({ range_km: HILUX_FIXTURE_VEHICLE.range_km })
    ).toBe(true);
  });

  it('is the Hilux as production holds it', () => {
    // Read-only from the production `vehicles` row on 2026-08-27. Pinned so a
    // later "tidy-up" of the constant is a deliberate act, not a typo.
    expect(HILUX_FIXTURE_VEHICLE).toEqual({ name: 'Hilux', range_km: 500, fuel_type: null });
  });
});

describe('a trip cannot be planned without a vehicle', () => {
  it('rejects the state the owner actually saw: legs, and no vehicle anywhere', () => {
    const reason = impossibleFixtureTripReason({
      onboardingState: 'not_started',
      hasLegs: true,
      ownerBestRangeKm: null,
    });
    // Note the onboarding state: the trip that broke was a CLONE, and cloning
    // copies legs while leaving `onboarding_state` at its default. Legs alone
    // are enough to make it impossible — planning is what needs the vehicle.
    expect(reason).toContain('No vehicle on file for user');
  });

  it('rejects a trip that has left onboarding with no vehicle', () => {
    expect(
      impossibleFixtureTripReason({
        onboardingState: 'done',
        hasLegs: false,
        ownerBestRangeKm: null,
      })
    ).toContain('onboarding');
  });

  it('rejects an owner whose only vehicle is missing its range', () => {
    // The `vehicle_new` fixture's half-built vehicle. Harmless while the trip
    // is still inside onboarding (below); not harmless once it is planned.
    expect(
      impossibleFixtureTripReason({ ...PLANNED_WITH_HILUX, ownerBestRangeKm: null })
    ).not.toBeNull();
  });

  it('rejects a range outside the band the planner will accept', () => {
    // A number is not the same as a usable number: Finn's bounds are
    // FUEL_STOP_SPACING_KM_MIN/MAX, and the predicate defers to the app's own
    // check rather than restating them.
    for (const rangeKm of [1, 199, 1501]) {
      expect(
        impossibleFixtureTripReason({ ...PLANNED_WITH_HILUX, ownerBestRangeKm: rangeKm }),
        `${rangeKm} km must be refused`
      ).not.toBeNull();
    }
  });

  it('accepts a planned trip whose owner drives the Hilux', () => {
    expect(impossibleFixtureTripReason(PLANNED_WITH_HILUX)).toBeNull();
  });

  it('accepts an owner who also owns an unusable vehicle, as long as one works', () => {
    // Only the best vehicle matters — fuel planning falls back to the account's
    // default, and a leftover half-built row does not make the account broken.
    expect(
      impossibleFixtureTripReason({ ...PLANNED_WITH_HILUX, ownerBestRangeKm: 500 })
    ).toBeNull();
  });
});

describe('a trip still inside onboarding may have no vehicle — that is the point', () => {
  it('allows the not-yet-started trip the onboarding specs need', () => {
    // `POST /api/trips` takes `vehicle_id` as optional and onboarding collects
    // the vehicle afterwards, so "trip row without a vehicle" is a legitimate
    // state. Tightening this predicate to forbid it would break the flow it is
    // meant to protect.
    expect(
      impossibleFixtureTripReason({
        onboardingState: 'not_started',
        hasLegs: false,
        ownerBestRangeKm: null,
      })
    ).toBeNull();
  });

  it('allows a trip parked on the vehicle step with a half-built vehicle', () => {
    expect(
      impossibleFixtureTripReason({
        onboardingState: 'vehicle_new',
        hasLegs: false,
        ownerBestRangeKm: null,
      })
    ).toBeNull();
  });
});

describe('every fixture builder is held to the rule', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../server/repos/testSupport.ts'),
    'utf8'
  );

  it('checks the trip it just wrote, once per trip it writes', () => {
    // The cheapest way to keep a NEW fixture builder from repeating the bug:
    // if you add a trip-creating helper here, you also add the check, or this
    // fails with the count that gave you away.
    const created = source.match(/await createTrip\(/g)?.length ?? 0;
    const checked = source.match(/await assertFixtureTripPossible\(/g)?.length ?? 0;
    expect(created).toBeGreaterThan(0);
    expect(
      checked,
      `testSupport.ts creates ${created} fixture trips but only checks ${checked}. ` +
        'Every builder must end with assertFixtureTripPossible(tripId, userId, label).'
    ).toBe(created);
  });

  it('sources the fixture vehicle from the shared constant, not a fresh number', () => {
    expect(source).toContain('HILUX_FIXTURE_VEHICLE');
    // The old literal. A `range_km: 400` reappearing means someone re-invented
    // the vehicle instead of importing it.
    expect(source).not.toMatch(/range_km:\s*\d/);
  });
});
