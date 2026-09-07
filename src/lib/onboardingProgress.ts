import type { OnboardingState } from '@/types/trip';
import { isTripDateLabel, isTripOriginLabel, isTripPaceLabel, UNITS_LABEL } from '@/lib/onboardingForm';

/**
 * The onboarding step counter, as ONE pure function.
 *
 * It used to be derived in three places (the intent snapshot, the per-state
 * snapshot, and the submit path) from `2 + units + vehicleQuestions.length`,
 * and every one of them lied somewhere: the total read 5 on a flow that
 * finishes on a single vehicle card, dropped to 3 the moment units were
 * chosen (because "units not yet chosen" was the only thing counting that
 * step), and never noticed when the date question had been skipped. The
 * counter is a promise to the user about how much is left, and a promise
 * that changes its mind on every screen is worse than none.
 *
 * Steps, in order: trip_intent · [trip_origin] · [trip_date] · [trip_pace]
 * · [units_pick] · vehicle. The bracketed ones are conditional, and whether
 * each is IN this flow is read from evidence rather than from the current
 * state:
 *
 *   - a step ALREADY ASKED is in the flow — its question was written to
 *     `chat_history` as a `form_question` row, which is what `askedLabels`
 *     holds. This is the same evidence `loadAskedLabels` has always used, and
 *     it survives reloads and answers alike.
 *   - a step NOT YET REACHED is in the flow unless it is known to be skipped:
 *     the date when the opening message carried an exact one (`dateSkipped`),
 *     units when the account already has a preference.
 *   - the origin step is asked ONLY when the opening message did not state
 *     one, and that is not known until the message is scanned — so before
 *     trip_intent is answered it is counted absent. The total may therefore
 *     grow by one after the first answer. That is honest: the alternative is
 *     to promise five steps to the majority who will only ever see four.
 */
export interface OnboardingProgressInput {
  state: OnboardingState;
  /** `form_question` labels already written to this trip's chat history. */
  askedLabels: ReadonlySet<string>;
  /** The opening message carried an exact date, so trip_date will not run. */
  dateSkipped: boolean;
  /** The opening message stated a daily driving time, so trip_pace will not run. */
  paceSkipped: boolean;
  /** The account already holds a units preference (raw column non-null). */
  unitsChosen: boolean;
  /**
   * The vehicle walker's own progress while in `vehicle_new`; null before.
   * `total` is 1 for the composite card and the question count otherwise.
   */
  vehicle: { current: number; total: number } | null;
  /** Vehicle steps a flow that has not reached the vehicle yet will take. */
  vehicleStepsAhead: number;
}

export function computeOnboardingProgress(
  input: OnboardingProgressInput,
): { current: number; total: number } | null {
  const { state, askedLabels } = input;
  if (state === 'range_help' || state === 'done') return null;

  const asked = (pred: (label: string) => boolean) => {
    for (const l of askedLabels) if (pred(l)) return true;
    return false;
  };

  const originIn = state === 'trip_origin' || asked(isTripOriginLabel);
  const dateIn =
    state === 'trip_date' ||
    asked(isTripDateLabel) ||
    // Not reached yet: in unless skipped. At trip_intent the scan has not run.
    ((state === 'trip_intent' || state === 'trip_origin') && !input.dateSkipped);
  const beforePace = state === 'trip_intent' || state === 'trip_origin' || state === 'trip_date';
  const paceIn = state === 'trip_pace' || asked(isTripPaceLabel) || (beforePace && !input.paceSkipped);
  const unitsIn =
    state === 'units_pick' ||
    askedLabels.has(UNITS_LABEL) ||
    ((beforePace || state === 'trip_pace') && !input.unitsChosen);

  const preVehicle =
    1 + (originIn ? 1 : 0) + (dateIn ? 1 : 0) + (paceIn ? 1 : 0) + (unitsIn ? 1 : 0);
  const vehicleTotal = input.vehicle?.total ?? input.vehicleStepsAhead;
  const total = preVehicle + vehicleTotal;

  let current: number;
  switch (state) {
    case 'trip_intent':
    case 'not_started':
      current = 1;
      break;
    case 'trip_origin':
      current = 2;
      break;
    case 'trip_date':
      current = 2 + (originIn ? 1 : 0);
      break;
    case 'trip_pace':
      current = 2 + (originIn ? 1 : 0) + (dateIn ? 1 : 0);
      break;
    case 'units_pick':
      current = 2 + (originIn ? 1 : 0) + (dateIn ? 1 : 0) + (paceIn ? 1 : 0);
      break;
    case 'vehicle_new':
      current = preVehicle + (input.vehicle?.current ?? 1);
      break;
    default:
      // Legacy states are advanced on read before a snapshot is returned.
      return null;
  }
  return { current: Math.min(current, total), total };
}
