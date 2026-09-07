import { describe, it, expect } from 'vitest';
import { computeOnboardingProgress } from './onboardingProgress';
import {
  TRIP_DATE_LABEL,
  TRIP_INTENT_LABEL,
  TRIP_ORIGIN_LABEL,
  TRIP_PACE_LABEL,
  UNITS_LABEL,
  tripOriginLabelFor,
} from './onboardingForm';

const base = {
  askedLabels: new Set<string>(),
  dateSkipped: false,
  paceSkipped: false,
  unitsChosen: false,
  vehicle: null,
  vehicleStepsAhead: 1,
};

describe('computeOnboardingProgress', () => {
  it('a first-run flow reads 1 of 5 on the greeting: intent, date, pace, units, vehicle', () => {
    expect(computeOnboardingProgress({ ...base, state: 'trip_intent' })).toEqual({
      current: 1,
      total: 5,
    });
  });

  it('a message that states the pace drops that step', () => {
    expect(
      computeOnboardingProgress({ ...base, state: 'trip_date', paceSkipped: true }),
    ).toEqual({ current: 2, total: 4 });
  });

  it('units already chosen removes a step before it is reached', () => {
    expect(
      computeOnboardingProgress({ ...base, state: 'trip_intent', unitsChosen: true }),
    ).toEqual({ current: 1, total: 4 });
  });

  it('the origin step joins the count the moment it is asked', () => {
    expect(computeOnboardingProgress({ ...base, state: 'trip_origin' })).toEqual({
      current: 2,
      total: 6,
    });
  });

  it('the origin step stays counted after it was answered', () => {
    const askedLabels = new Set([TRIP_INTENT_LABEL, tripOriginLabelFor('Girona')]);
    expect(computeOnboardingProgress({ ...base, state: 'trip_date', askedLabels })).toEqual({
      current: 3,
      total: 6,
    });
  });

  it('a skipped date shortens the flow rather than leaving a gap', () => {
    const askedLabels = new Set([TRIP_INTENT_LABEL, TRIP_ORIGIN_LABEL, TRIP_PACE_LABEL]);
    expect(
      computeOnboardingProgress({ ...base, state: 'trip_origin', dateSkipped: true }),
    ).toEqual({ current: 2, total: 5 });
    expect(
      computeOnboardingProgress({ ...base, state: 'units_pick', askedLabels, dateSkipped: true }),
    ).toEqual({ current: 4, total: 5 });
  });

  it('the total does NOT shrink when units are chosen mid-flow', () => {
    // The bug: "units not yet chosen" was the only thing counting the units
    // step, so answering it made the total drop from 5 to 3 on the next card.
    const askedLabels = new Set([TRIP_INTENT_LABEL, TRIP_DATE_LABEL, TRIP_PACE_LABEL, UNITS_LABEL]);
    expect(
      computeOnboardingProgress({
        ...base,
        state: 'vehicle_new',
        askedLabels,
        unitsChosen: true,
        vehicle: { current: 1, total: 1 },
      }),
    ).toEqual({ current: 5, total: 5 });
  });

  it('a vehicle with a name and no range counts its remaining questions', () => {
    const askedLabels = new Set([TRIP_INTENT_LABEL, TRIP_DATE_LABEL, TRIP_PACE_LABEL, UNITS_LABEL]);
    expect(
      computeOnboardingProgress({
        ...base,
        state: 'vehicle_new',
        askedLabels,
        unitsChosen: true,
        vehicle: { current: 2, total: 2 },
      }),
    ).toEqual({ current: 6, total: 6 });
  });

  it('the estimator interstitial has no number', () => {
    expect(computeOnboardingProgress({ ...base, state: 'range_help' })).toBeNull();
  });

  it('the counter never runs past the total', () => {
    const askedLabels = new Set([TRIP_INTENT_LABEL, TRIP_DATE_LABEL]);
    expect(
      computeOnboardingProgress({
        ...base,
        state: 'vehicle_new',
        askedLabels,
        unitsChosen: true,
        vehicle: { current: 3, total: 1 },
      }),
    ).toEqual({ current: 3, total: 3 });
  });
});
