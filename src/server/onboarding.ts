import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { chatHistory, trips } from '@/server/db/schema';
import { addChatMessage } from '@/server/repos/chat';
import {
  addVehicle,
  getVehicleForUser,
  listVehiclesForUser,
  updateVehicle,
  type VehicleApi,
} from '@/server/repos/vehicles';
import { getUnitsPref, getRawUnitsPref, setUnitsPref } from '@/server/repos/users';
import { miToKm } from '@/lib/units';
import type { UnitsPref } from '@/lib/units';
import type { OnboardingState } from '@/types/trip';
import { assertTripNameAvailable } from '@/server/repos/trips';
import {
  buildVehicleProfileQuestions,
  caravanDumpStationGateLabel,
  CARAVAN_DUMP_STATION_GATE_KEY,
  coerceVehicleProfileValue,
  deriveMaxDriveHoursPerWeek,
  humanizeVehicleProfileAnswer,
  vehicleProfileQuestionAllowsNull,
  type VehicleProfileQuestion,
} from '@/lib/vehicleProfile';

// ---------------------------------------------------------------------------
// Onboarding is a deterministic form-in-chat that gathers everything Penny
// needs BEFORE the first real Anthropic call. Flow:
//
//   not_started  → trip_intent (Penny greeting + "where do you want to go?")
//   trip_intent  → trip_name ("what would you like to name this trip?")
//   trip_name    → units_pick (if units_pref NULL) | else vehicle_new
//   units_pick   → metric/imperial persisted → vehicle_new
//   vehicle_new  → profile questions + caravan gate → done (handoff)
//
// New users never have existing vehicles, so there is no vehicle_pick step.
// When the final question is answered, onboarding transitions to 'done' and
// the stored pending_intent (from trip_intent) is returned so the client can
// fire the LLM with it.
// ---------------------------------------------------------------------------

export type QuestionKind =
  | 'text'
  | 'number'
  | 'integer'
  | 'select'
  | 'handoff';

export interface SelectOption {
  value: string;
  label: string;
}

export interface Question {
  key: string;
  kind: QuestionKind;
  label: string;
  placeholder?: string;
  help?: string;
  options?: SelectOption[];
  optional?: boolean;
  min?: number;
  max?: number;
  /** UI hint: render a multiline textarea instead of an input. */
  multiline?: boolean;
}

// ---------------------------------------------------------------------------
// Onboarding questions
// ---------------------------------------------------------------------------

export const TRIP_INTENT_QUESTION: Question = {
  key: 'trip_intent',
  kind: 'handoff',
  label: "Hi, I'm Penny — your personal travel assistant.\n\nTell me where you want to go. Is there anything cool along the way you want or need to stop at? I'll go do all the legwork so all you have to do is drive and enjoy.\n\nI can also update anything on the itinerary anytime. If you need a gas stop sooner just let me know and I'll find one for you along the route.\n\nExample: \"I wanna do a roadtrip from where I live in Girona Spain to the Gorafe desert, I will need groceries along the way, and I need to fill up my water tank\"",
  placeholder: "Tell Penny about your trip…",
  multiline: true,
};

const TRIP_NAME_QUESTION: Question = {
  key: 'trip_name',
  kind: 'text',
  label: 'What would you like to name this trip?',
  placeholder: 'e.g. Spain Desert Run, Nordic Adventure',
};

/** @deprecated Kept for backwards compatibility with old onboarding states. */
export const HANDOFF_QUESTION = TRIP_INTENT_QUESTION;

const UNITS_PREF_KEY = 'units_pref';

// ---------------------------------------------------------------------------

export interface OnboardingSnapshot {
  state: OnboardingState;
  /** Next question to ask, or null if onboarding is done. */
  question: Question | null;
  /** @deprecated Legacy field — vehicle_pick no longer part of onboarding. Always empty. */
  vehicles: Array<{ id: string; name: string; is_default: boolean }>;
  /** Progress counter — "3 of 8" style. */
  progress: { current: number; total: number } | null;
}

type OnboardingStep = { t: 'profile'; q: VehicleProfileQuestion } | { t: 'gate' };

function buildOnboardingSteps(units: UnitsPref): OnboardingStep[] {
  const qs = buildVehicleProfileQuestions(units);
  const wi = qs.findIndex((q) => q.group === 'dump_station');
  if (wi < 0) return qs.map((q) => ({ t: 'profile' as const, q }));
  return [
    ...qs.slice(0, wi).map((q) => ({ t: 'profile' as const, q })),
    { t: 'gate' },
    ...qs.slice(wi).map((q) => ({ t: 'profile' as const, q })),
  ];
}

function vehicleHasProfileValue(vehicle: VehicleApi, key: string): boolean {
  const raw = (vehicle as unknown as Record<string, unknown>)[key];
  return raw !== null && raw !== undefined && raw !== '';
}

function dumpStationGroupHasAnyValue(vehicle: VehicleApi, questions: VehicleProfileQuestion[]): boolean {
  return questions.filter((q) => q.group === 'dump_station').some((q) => vehicleHasProfileValue(vehicle, q.key));
}

/** Caravan gate resolved via DB (`dump_station_tracking_enabled`) or legacy onboarding chat / populated dump station rows. */
function caravanGateResolved(
  vehicle: VehicleApi,
  askedLabels: Set<string>,
  questions: VehicleProfileQuestion[]
): boolean {
  const wt = vehicle.dump_station_tracking_enabled;
  if (wt === true || wt === false) return true;
  return askedLabels.has(caravanDumpStationGateLabel()) || dumpStationGroupHasAnyValue(vehicle, questions);
}

/**
 * Determine the next state after trip_name: units_pick (if not yet chosen),
 * or straight to vehicle_new (new users always create a vehicle).
 */
async function resolvePostNameState(userId: string): Promise<OnboardingState> {
  const unitsChosen = (await getRawUnitsPref(userId)) != null;
  return unitsChosen ? 'vehicle_new' : 'units_pick';
}

/**
 * When we're in `vehicle_new`, walk onboarding steps (profile fields + caravan
 * gate before water). See `loadAskedLabels` for optional-field / skip behavior.
 */
function nextVehicleOnboardingQuestion(
  vehicle: VehicleApi | null,
  askedLabels: Set<string>,
  unitsPref: UnitsPref
): { question: Question; progress: { current: number; total: number } } | null {
  const questions = buildVehicleProfileQuestions(unitsPref);
  const steps = buildOnboardingSteps(unitsPref);
  const gateLabel = caravanDumpStationGateLabel();

  // When the user said "No" to caravan tracking, exclude the gate step and
  // all dump_station profile steps from the total count so progress shows
  // e.g. "4 of 5" instead of "4 of 7".
  const dumpStationDisabled = vehicle?.dump_station_tracking_enabled === false;
  const visibleSteps = dumpStationDisabled
    ? steps.filter((s) => s.t !== 'gate' && !(s.t === 'profile' && s.q.group === 'dump_station'))
    : steps;
  const total = visibleSteps.length;

  if (!vehicle) {
    const first = steps[0];
    if (first.t !== 'profile') throw new Error('Expected profile as first onboarding step');
    return {
      question: first.q as Question,
      progress: { current: 1, total },
    };
  }

  // Track position within the visible steps for progress display.
  let visibleIdx = 0;
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];

    if (step.t === 'gate') {
      if (dumpStationDisabled) continue; // gate already answered "no" — skip
      const gateResolved = caravanGateResolved(vehicle, askedLabels, questions);
      if (!gateResolved) {
        return {
          question: {
            key: CARAVAN_DUMP_STATION_GATE_KEY,
            kind: 'select',
            label: gateLabel,
            help: 'If not, we will skip dump station timing questions.',
            options: [
              { value: 'yes', label: 'Yes, track dump station visits' },
              { value: 'no', label: 'No' },
            ],
          },
          progress: { current: visibleIdx + 1, total },
        };
      }
      visibleIdx++;
      continue;
    }

    const q = step.q;

    // Skip dump_station questions entirely when tracking is disabled.
    if (dumpStationDisabled && q.group === 'dump_station') continue;

    const hasVal = vehicleHasProfileValue(vehicle, q.key);
    const resolved = q.optional ? hasVal || askedLabels.has(q.label) : hasVal;
    if (!resolved) {
      return {
        question: q as Question,
        progress: { current: visibleIdx + 1, total },
      };
    }
    visibleIdx++;
  }

  return null;
}

/**
 * Load the set of question labels we've already written to chat_history as
 * form_question rows. Used to detect "user already saw this question" for
 * optional fields that might legitimately still be null after a skip.
 */
async function loadAskedLabels(tripId: string): Promise<Set<string>> {
  const rows = await db
    .select({ content: chatHistory.content })
    .from(chatHistory)
    .where(and(eq(chatHistory.tripId, tripId), eq(chatHistory.kind, 'form_question')));
  return new Set(rows.map((r) => r.content));
}

/**
 * Complete onboarding: set state to 'done', return the stored intent for
 * the client to fire at the LLM.
 */
async function completeOnboarding(
  tripId: string,
): Promise<SubmitAnswerResult> {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  const pendingIntent = trip?.pendingIntent ?? '';
  // Clear pendingIntent now that we're handing off
  await db
    .update(trips)
    .set({ onboardingState: 'done', pendingIntent: null, updatedAt: new Date() })
    .where(eq(trips.id, tripId));
  return {
    next: { state: 'done', question: null, vehicles: [], progress: null },
    answerLabel: '',
    didHandoff: true,
    tripIntent: pendingIntent,
  };
}

// ---------------------------------------------------------------------------
// Snapshot: returns the current onboarding question for a trip
// ---------------------------------------------------------------------------

export async function getOnboardingSnapshot(
  tripId: string,
  userId: string
): Promise<OnboardingSnapshot> {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip || trip.userId !== userId) throw new Error('Trip not found');

  let state = trip.onboardingState as OnboardingState;

  // First visit — show Penny's greeting + trip intent question
  if (state === 'not_started') {
    await db
      .update(trips)
      .set({ onboardingState: 'trip_intent', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    state = 'trip_intent';
  }

  // Pre-vehicle steps: trip_intent + trip_name + units_pick (if not yet set).
  // We count them so the progress bar reflects the full onboarding, not just
  // the vehicle-profile portion.
  const unitsAlreadyChosen = (await getRawUnitsPref(userId)) != null;
  // trip_intent doesn't count in the numbered progress (it's the greeting).
  // Steps shown in progress: trip_name, [units_pick], then vehicle steps.
  const preVehicleSteps = unitsAlreadyChosen ? 1 : 2; // trip_name [+ units_pick]

  if (state === 'trip_intent') {
    return {
      state: 'trip_intent',
      question: TRIP_INTENT_QUESTION,
      vehicles: [],
      progress: null,
    };
  }

  // Compute total for progress: preVehicleSteps + vehicle profile steps.
  // We need units pref for vehicle questions — use 'metric' as default since
  // we might not know yet, but the count is the same either way.
  const vehicleSteps = buildOnboardingSteps(unitsAlreadyChosen ? await getUnitsPref(userId) : 'metric');
  const totalSteps = preVehicleSteps + vehicleSteps.length;

  if (state === 'trip_name') {
    return {
      state: 'trip_name',
      question: TRIP_NAME_QUESTION,
      vehicles: [],
      progress: { current: 1, total: totalSteps },
    };
  }

  if (state === 'units_pick') {
    return {
      state: 'units_pick',
      question: {
        key: UNITS_PREF_KEY,
        kind: 'select',
        label: 'Do you want distances in metric (kilometers) or imperial (miles)?',
        help: 'Fuel planning and the database always use kilometers; this only affects how questions are worded.',
        options: [
          { value: 'metric', label: 'Metric (km)' },
          { value: 'imperial', label: 'Imperial (cheeseburgers)' },
        ],
      },
      vehicles: [],
      progress: { current: 2, total: totalSteps },
    };
  }

  if (state === 'vehicle_pick') {
    // Legacy: vehicle_pick no longer exists in onboarding — redirect to vehicle_new
    await db
      .update(trips)
      .set({ onboardingState: 'vehicle_new', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    return getOnboardingSnapshot(tripId, userId);
  }

  if (state === 'vehicle_new') {
    // If the trip has no vehicle yet but the account owns exactly one row,
    // attach it so we complete that profile instead of creating a duplicate via
    // the "name first" branch of submitAnswer.
    let vehicleIdForFlow = trip.vehicleId;
    if (!vehicleIdForFlow) {
      const owned = await listVehiclesForUser(userId);
      if (owned.length === 1) {
        vehicleIdForFlow = owned[0].id;
        await db
          .update(trips)
          .set({ vehicleId: vehicleIdForFlow, updatedAt: new Date() })
          .where(eq(trips.id, tripId));
      }
    }
    const currentVehicle = vehicleIdForFlow
      ? await getVehicleForUser(userId, vehicleIdForFlow)
      : null;
    const askedLabels = await loadAskedLabels(tripId);
    const unitsPref = await getUnitsPref(userId);
    const next = nextVehicleOnboardingQuestion(currentVehicle, askedLabels, unitsPref);
    if (!next) {
      // All vehicle questions answered — complete onboarding
      await db
        .update(trips)
        .set({ onboardingState: 'done', updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      return { state: 'done', question: null, vehicles: [], progress: null };
    }
    // Offset vehicle progress by the pre-vehicle steps so the counter
    // reflects the full onboarding flow (trip_name + [units_pick] + vehicle).
    return {
      state,
      question: next.question,
      vehicles: [],
      progress: {
        current: preVehicleSteps + next.progress.current,
        total: preVehicleSteps + next.progress.total,
      },
    };
  }

  // Legacy states — map to the new flow
  if (state === 'ready') {
    // Old state where HANDOFF was shown. Now equivalent to trip_intent if
    // no pending_intent exists, or done if it does.
    if (trip.pendingIntent) {
      await db
        .update(trips)
        .set({ onboardingState: 'done', updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      return { state: 'done', question: null, vehicles: [], progress: null };
    }
    await db
      .update(trips)
      .set({ onboardingState: 'trip_intent', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    return getOnboardingSnapshot(tripId, userId);
  }

  if (state === 'preferences') {
    await db
      .update(trips)
      .set({ onboardingState: 'trip_intent', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    return getOnboardingSnapshot(tripId, userId);
  }

  return { state: 'done', question: null, vehicles: [], progress: null };
}

// ---------------------------------------------------------------------------
// Submit answer
// ---------------------------------------------------------------------------

export interface SubmitAnswerInput {
  questionKey: string;
  value: unknown; // string | number | 'new' | vehicle id
}

export interface SubmitAnswerResult {
  next: OnboardingSnapshot;
  answerLabel: string;
  didHandoff: boolean;
  /** The stored trip intent to send to Penny when onboarding is done. */
  tripIntent?: string;
}

export async function submitAnswer(
  tripId: string,
  userId: string,
  input: SubmitAnswerInput
): Promise<SubmitAnswerResult> {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip || trip.userId !== userId) throw new Error('Trip not found');
  const state = trip.onboardingState as OnboardingState;

  // ---- Trip intent (first question) ----
  if (state === 'trip_intent' && input.questionKey === 'trip_intent') {
    const text = typeof input.value === 'string' ? input.value.trim() : '';
    if (!text) throw new Error('Please describe your trip.');
    // Store the intent on the trip for later handoff
    await db
      .update(trips)
      .set({ pendingIntent: text, onboardingState: 'trip_name', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    await writeQA(tripId, TRIP_INTENT_QUESTION.label, text);
    return {
      next: await getOnboardingSnapshot(tripId, userId),
      answerLabel: text,
      didHandoff: false,
    };
  }

  // ---- Trip name (second question) ----
  if (state === 'trip_name' && input.questionKey === 'trip_name') {
    const name = typeof input.value === 'string' ? input.value.trim() : '';
    if (!name) throw new Error('Please name your trip.');
    // Validate uniqueness and rename the trip
    await assertTripNameAvailable(userId, name, tripId);
    await db
      .update(trips)
      .set({ name, updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    // Determine next state: units if not chosen, else vehicle flow
    const nextState = await resolvePostNameState(userId);
    await db
      .update(trips)
      .set({ onboardingState: nextState, updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    await writeQA(tripId, TRIP_NAME_QUESTION.label, name);
    return {
      next: await getOnboardingSnapshot(tripId, userId),
      answerLabel: name,
      didHandoff: false,
    };
  }

  // ---- Units preference ----
  if (state === 'units_pick' && input.questionKey === UNITS_PREF_KEY) {
    const raw = input.value;
    if (raw !== 'metric' && raw !== 'imperial') {
      throw new Error('Choose metric or imperial.');
    }
    await setUnitsPref(userId, raw);
    const nextState: OnboardingState = 'vehicle_new';
    await db
      .update(trips)
      .set({ onboardingState: nextState, updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    const answerLabel = raw === 'metric' ? 'Metric (kilometers)' : 'Imperial (miles)';
    await writeQA(
      tripId,
      'Do you want distances in metric (kilometers) or imperial (miles)?',
      answerLabel
    );
    return {
      next: await getOnboardingSnapshot(tripId, userId),
      answerLabel,
      didHandoff: false,
    };
  }

  // ---- Vehicle new / profile questions ----
  if (state === 'vehicle_new') {
    const unitsPref = await getUnitsPref(userId);
    const questions = buildVehicleProfileQuestions(unitsPref);
    const gateLabel = caravanDumpStationGateLabel();

    if (input.questionKey === CARAVAN_DUMP_STATION_GATE_KEY) {
      const raw = typeof input.value === 'string' ? input.value : '';
      if (raw !== 'yes' && raw !== 'no') throw new Error('Pick yes or no.');
      if (!trip.vehicleId) throw new Error('Vehicle not ready for caravan gate.');
      await updateVehicle(userId, trip.vehicleId, {
        dump_station_tracking_enabled: raw === 'yes',
        ...(raw === 'no' ? { dump_station_interval_days: null } : {}),
      });
      if (raw === 'no') {
        const dsIdx = questions.findIndex((q) => q.group === 'dump_station');
        if (dsIdx >= 0) {
          for (const wq of questions.slice(dsIdx)) {
            await addChatMessage(tripId, 'assistant', wq.label, null, 'form_question');
            await addChatMessage(tripId, 'user', 'Not applicable', null, 'form_answer');
          }
        }
      }
      await writeQA(tripId, gateLabel, raw === 'yes' ? 'Yes' : 'No');
      // Check if that was the last question
      const afterSnapshot = await getOnboardingSnapshot(tripId, userId);
      if (afterSnapshot.state === 'done') {
        return completeOnboarding(tripId);
      }
      return {
        next: afterSnapshot,
        answerLabel: raw === 'yes' ? 'Yes' : 'No',
        didHandoff: false,
      };
    }

    const question = questions.find((q) => q.key === input.questionKey);
    if (!question) throw new Error(`Unknown question ${input.questionKey}`);

    let vehicle: VehicleApi | null = trip.vehicleId
      ? await getVehicleForUser(userId, trip.vehicleId)
      : null;

    const vehicleRecord = (vehicle ?? {
      dump_station_tracking_enabled: undefined,
    }) as unknown as Record<string, unknown>;
    if (
      !vehicleProfileQuestionAllowsNull(question, vehicleRecord) &&
      (input.value === null || input.value === undefined || input.value === '')
    ) {
      throw new Error('This field is required.');
    }

    const parsed = coerceVehicleProfileValue(question, input.value);

    if (!vehicle) {
      if (question.key !== 'name') {
        throw new Error('Expected vehicle name before other fields');
      }
      const name = typeof parsed === 'string' ? parsed.trim() : '';
      if (!name) throw new Error('Name required');
      vehicle = await addVehicle(userId, { name, is_default: false });
      await db
        .update(trips)
        .set({ vehicleId: vehicle.id, updatedAt: new Date() })
        .where(eq(trips.id, tripId));
    } else {
      const patch: Record<string, unknown> = {};
      if (question.key === 'refill_distance_km' && unitsPref === 'imperial') {
        const km = parsed == null ? null : miToKm(parsed as number);
        patch.refill_distance_km = km == null ? null : Math.round(km);
      } else {
        patch[question.key] = parsed;
      }
      const nextDay =
        (patch.max_drive_hours_per_day as number | undefined) ?? vehicle.max_drive_hours_per_day;
      const nextConsec =
        (patch.max_consecutive_drive_days as number | undefined) ?? vehicle.max_consecutive_drive_days;
      if (
        typeof nextDay === 'number' &&
        nextDay > 0 &&
        typeof nextConsec === 'number' &&
        nextConsec > 0
      ) {
        patch.max_drive_hours_per_week = deriveMaxDriveHoursPerWeek(nextDay, nextConsec);
      }
      await updateVehicle(userId, vehicle.id, patch);
    }

    const answerLabel = humanizeVehicleProfileAnswer(question, parsed, unitsPref);
    await writeQA(tripId, question.label, answerLabel);

    const afterSnapshot = await getOnboardingSnapshot(tripId, userId);
    // If all vehicle questions are done, complete onboarding and handoff
    if (afterSnapshot.state === 'done') {
      return completeOnboarding(tripId);
    }
    return {
      next: afterSnapshot,
      answerLabel,
      didHandoff: false,
    };
  }

  // ---- Legacy: 'ready' state with 'handoff' key (old clients) ----
  if (state === 'ready' && input.questionKey === 'handoff') {
    const text = typeof input.value === 'string' ? input.value.trim() : '';
    if (!text) throw new Error('Please describe your trip.');
    await addChatMessage(tripId, 'assistant', TRIP_INTENT_QUESTION.label, null, 'form_question');
    await db
      .update(trips)
      .set({ onboardingState: 'done', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    return {
      next: { state: 'done', question: null, vehicles: [], progress: null },
      answerLabel: text,
      didHandoff: true,
      tripIntent: text,
    };
  }

  throw new Error(`Cannot answer question "${input.questionKey}" in state "${state}"`);
}

// ---------------------------------------------------------------------------

async function writeQA(tripId: string, question: string, answer: string) {
  await addChatMessage(tripId, 'assistant', question, null, 'form_question');
  await addChatMessage(tripId, 'user', answer, null, 'form_answer');
}
