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
import {
  buildVehicleProfileQuestions,
  caravanWaterGateLabel,
  CARAVAN_WATER_GATE_KEY,
  coerceVehicleProfileValue,
  humanizeVehicleProfileAnswer,
  vehicleMeetsFuelPlanningMinimum,
  type VehicleProfileQuestion,
} from '@/lib/vehicleProfile';

// ---------------------------------------------------------------------------
// Onboarding is a deterministic form-in-chat that gathers everything Penny
// needs BEFORE the first real Anthropic call. Flow:
//
//   not_started  → units_pick (if units_pref NULL) | else vehicle_pick | vehicle_new
//   units_pick   → metric/imperial persisted → vehicle_pick | vehicle_new
//   vehicle_pick → existing & complete → ready | incomplete → vehicle_new
//                  "new" → vehicle_new
//   vehicle_new  → profile questions + caravan gate → ready
//   ready        → handoff → done → Penny
// ---------------------------------------------------------------------------

export type QuestionKind =
  | 'text'
  | 'number'
  | 'integer'
  | 'select'
  | 'vehicle_pick'
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

export const HANDOFF_QUESTION: Question = {
  key: 'handoff',
  kind: 'handoff',
  label: "Where do you want to go? Tell me like you would a friend.",
  placeholder: 'e.g. Spain → Portugal over three weeks, leaving mid-June, chasing beaches and tapas',
  multiline: true,
};

const UNITS_PREF_KEY = 'units_pref';

// ---------------------------------------------------------------------------

export interface OnboardingSnapshot {
  state: OnboardingState;
  /** Next question to ask, or null if onboarding is done. */
  question: Question | null;
  /** For 'vehicle_pick', the candidate vehicles. */
  vehicles: Array<{ id: number; name: string; is_default: boolean }>;
  /** Progress counter — "3 of 8" style. */
  progress: { current: number; total: number } | null;
}

type OnboardingStep = { t: 'profile'; q: VehicleProfileQuestion } | { t: 'gate' };

function buildOnboardingSteps(units: UnitsPref): OnboardingStep[] {
  const qs = buildVehicleProfileQuestions(units);
  const wi = qs.findIndex((q) => q.group === 'water');
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

function waterGroupHasAnyValue(vehicle: VehicleApi, questions: VehicleProfileQuestion[]): boolean {
  return questions.filter((q) => q.group === 'water').some((q) => vehicleHasProfileValue(vehicle, q.key));
}

/** Caravan gate resolved via DB (`water_tracking_enabled`) or legacy onboarding chat / populated water rows. */
function caravanGateResolved(
  vehicle: VehicleApi,
  askedLabels: Set<string>,
  questions: VehicleProfileQuestion[]
): boolean {
  const wt = vehicle.water_tracking_enabled;
  if (wt === true || wt === false) return true;
  return askedLabels.has(caravanWaterGateLabel()) || waterGroupHasAnyValue(vehicle, questions);
}

/**
 * Trips can only pick among vehicles that already have refill distance set;
 * otherwise we force vehicle_new so fuel planning cannot attach to an empty row.
 */
async function resolveStart(userId: string): Promise<OnboardingState> {
  const vehicles = await listVehiclesForUser(userId);
  const anyComplete = vehicles.some((v) => vehicleMeetsFuelPlanningMinimum(v as Record<string, unknown>));
  return anyComplete ? 'vehicle_pick' : 'vehicle_new';
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
  const total = steps.length;
  const gateLabel = caravanWaterGateLabel();

  if (!vehicle) {
    const first = steps[0];
    if (first.t !== 'profile') throw new Error('Expected profile as first onboarding step');
    return {
      question: first.q as Question,
      progress: { current: 1, total },
    };
  }

  for (let s = 0; s < steps.length; s++) {
    const step = steps[s];
    if (step.t === 'gate') {
      const gateResolved = caravanGateResolved(vehicle, askedLabels, questions);
      if (!gateResolved) {
        return {
          question: {
            key: CARAVAN_WATER_GATE_KEY,
            kind: 'select',
            label: gateLabel,
            help: 'If not, we will skip freshwater and waste timing questions.',
            options: [
              { value: 'yes', label: 'Yes, track water and dump timing' },
              { value: 'no', label: 'No' },
            ],
          },
          progress: { current: s + 1, total },
        };
      }
      continue;
    }

    const q = step.q;
    const hasVal = vehicleHasProfileValue(vehicle, q.key);
    const resolved = q.optional ? hasVal || askedLabels.has(q.label) : hasVal;
    if (!resolved) {
      return {
        question: q as Question,
        progress: { current: s + 1, total },
      };
    }
  }

  return null;
}

/**
 * Load the set of question labels we've already written to chat_history as
 * form_question rows. Used to detect "user already saw this question" for
 * optional fields that might legitimately still be null after a skip.
 */
async function loadAskedLabels(tripId: number): Promise<Set<string>> {
  const rows = await db
    .select({ content: chatHistory.content })
    .from(chatHistory)
    .where(and(eq(chatHistory.tripId, tripId), eq(chatHistory.kind, 'form_question')));
  return new Set(rows.map((r) => r.content));
}

export async function getOnboardingSnapshot(
  tripId: number,
  userId: string
): Promise<OnboardingSnapshot> {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip || trip.userId !== userId) throw new Error('Trip not found');

  let state = trip.onboardingState as OnboardingState;

  if (state === 'not_started') {
    const unitsChosen = (await getRawUnitsPref(userId)) != null;
    if (!unitsChosen) {
      await db
        .update(trips)
        .set({ onboardingState: 'units_pick', updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      state = 'units_pick';
    } else {
      const nextState = await resolveStart(userId);
      await db
        .update(trips)
        .set({ onboardingState: nextState, updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      state = nextState;
    }
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
          { value: 'imperial', label: 'Imperial (miles)' },
        ],
      },
      vehicles: [],
      progress: null,
    };
  }

  const vehicles = await listVehiclesForUser(userId);

  if (state === 'vehicle_pick') {
    const pickable = vehicles.filter((v) => vehicleMeetsFuelPlanningMinimum(v as Record<string, unknown>));
    if (pickable.length === 0) {
      await db
        .update(trips)
        .set({ onboardingState: 'vehicle_new', vehicleId: null, updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      return getOnboardingSnapshot(tripId, userId);
    }
    return {
      state,
      question: {
        key: 'vehicle_pick',
        kind: 'vehicle_pick',
        label: 'Which vehicle are you taking on this trip?',
      },
      vehicles: pickable.map((v) => ({
        id: v.id,
        name: v.name,
        is_default: v.is_default,
      })),
      progress: null,
    };
  }

  if (state === 'vehicle_new') {
    const currentVehicle = trip.vehicleId
      ? await getVehicleForUser(userId, trip.vehicleId)
      : null;
    const askedLabels = await loadAskedLabels(tripId);
    const unitsPref = await getUnitsPref(userId);
    const next = nextVehicleOnboardingQuestion(currentVehicle, askedLabels, unitsPref);
    if (!next) {
      await db
        .update(trips)
        .set({ onboardingState: 'ready', updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      return {
        state: 'ready',
        question: HANDOFF_QUESTION,
        vehicles: [],
        progress: null,
      };
    }
    return {
      state,
      question: next.question,
      vehicles: [],
      progress: next.progress,
    };
  }

  if (state === 'ready') {
    return { state, question: HANDOFF_QUESTION, vehicles: [], progress: null };
  }

  if (state === 'preferences') {
    await db
      .update(trips)
      .set({ onboardingState: 'ready', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    return { state: 'ready', question: HANDOFF_QUESTION, vehicles: [], progress: null };
  }

  return { state: 'done', question: null, vehicles: [], progress: null };
}

// ---------------------------------------------------------------------------

export interface SubmitAnswerInput {
  questionKey: string;
  value: unknown; // string | number | 'new' | vehicle id
}

export interface SubmitAnswerResult {
  next: OnboardingSnapshot;
  answerLabel: string;
  didHandoff: boolean;
}

export async function submitAnswer(
  tripId: number,
  userId: string,
  input: SubmitAnswerInput
): Promise<SubmitAnswerResult> {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip || trip.userId !== userId) throw new Error('Trip not found');
  const state = trip.onboardingState as OnboardingState;

  if (state === 'units_pick' && input.questionKey === UNITS_PREF_KEY) {
    const raw = input.value;
    if (raw !== 'metric' && raw !== 'imperial') {
      throw new Error('Choose metric or imperial.');
    }
    await setUnitsPref(userId, raw);
    const nextState = await resolveStart(userId);
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

  if (state === 'vehicle_pick' && input.questionKey === 'vehicle_pick') {
    if (input.value === 'new') {
      await db
        .update(trips)
        .set({ onboardingState: 'vehicle_new', vehicleId: null, updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      await writeQA(tripId, 'Which vehicle are you taking on this trip?', 'Add a new vehicle');
      return {
        next: await getOnboardingSnapshot(tripId, userId),
        answerLabel: 'Add a new vehicle',
        didHandoff: false,
      };
    }
    const vehicleId = Number(input.value);
    if (!Number.isFinite(vehicleId)) throw new Error('Invalid vehicle id');
    const chosen = await getVehicleForUser(userId, vehicleId);
    if (!chosen) throw new Error('Vehicle not found');
    const complete = vehicleMeetsFuelPlanningMinimum(chosen as Record<string, unknown>);
    if (complete) {
      await db
        .update(trips)
        .set({ vehicleId, onboardingState: 'ready', updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      await writeQA(
        tripId,
        'Which vehicle are you taking on this trip?',
        `Using ${chosen.name}`
      );
    } else {
      await db
        .update(trips)
        .set({ vehicleId, onboardingState: 'vehicle_new', updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      await writeQA(
        tripId,
        'Which vehicle are you taking on this trip?',
        `${chosen.name} — complete its profile next`
      );
    }
    return {
      next: await getOnboardingSnapshot(tripId, userId),
      answerLabel: complete ? `Using ${chosen.name}` : `${chosen.name} — finish setup`,
      didHandoff: false,
    };
  }

  if (state === 'vehicle_new') {
    const unitsPref = await getUnitsPref(userId);
    const questions = buildVehicleProfileQuestions(unitsPref);
    const gateLabel = caravanWaterGateLabel();

    if (input.questionKey === CARAVAN_WATER_GATE_KEY) {
      const raw = typeof input.value === 'string' ? input.value : '';
      if (raw !== 'yes' && raw !== 'no') throw new Error('Pick yes or no.');
      if (!trip.vehicleId) throw new Error('Vehicle not ready for caravan gate.');
      await updateVehicle(userId, trip.vehicleId, {
        water_tracking_enabled: raw === 'yes',
        ...(raw === 'no' ? { water_refill_days: null, blackwater_refill_days: null } : {}),
      });
      if (raw === 'no') {
        const waterIdx = questions.findIndex((q) => q.group === 'water');
        if (waterIdx >= 0) {
          for (const wq of questions.slice(waterIdx)) {
            await addChatMessage(tripId, 'assistant', wq.label, null, 'form_question');
            await addChatMessage(tripId, 'user', 'Not applicable', null, 'form_answer');
          }
        }
      }
      await writeQA(tripId, gateLabel, raw === 'yes' ? 'Yes' : 'No');
      return {
        next: await getOnboardingSnapshot(tripId, userId),
        answerLabel: raw === 'yes' ? 'Yes' : 'No',
        didHandoff: false,
      };
    }

    const question = questions.find((q) => q.key === input.questionKey);
    if (!question) throw new Error(`Unknown question ${input.questionKey}`);

    const parsed = coerceVehicleProfileValue(question, input.value);

    let vehicle: VehicleApi | null = trip.vehicleId
      ? await getVehicleForUser(userId, trip.vehicleId)
      : null;

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
      await updateVehicle(userId, vehicle.id, patch);
    }

    const answerLabel = humanizeVehicleProfileAnswer(question, parsed, unitsPref);
    await writeQA(tripId, question.label, answerLabel);

    const afterSnapshot = await getOnboardingSnapshot(tripId, userId);
    return {
      next: afterSnapshot,
      answerLabel,
      didHandoff: false,
    };
  }

  if (state === 'ready' && input.questionKey === 'handoff') {
    const text = typeof input.value === 'string' ? input.value.trim() : '';
    if (!text) throw new Error('Please describe your trip.');
    await addChatMessage(
      tripId,
      'assistant',
      HANDOFF_QUESTION.label,
      null,
      'form_question'
    );
    await db
      .update(trips)
      .set({ onboardingState: 'done', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    return {
      next: { state: 'done', question: null, vehicles: [], progress: null },
      answerLabel: text,
      didHandoff: true,
    };
  }

  throw new Error(`Cannot answer question "${input.questionKey}" in state "${state}"`);
}

// ---------------------------------------------------------------------------

async function writeQA(tripId: number, question: string, answer: string) {
  await addChatMessage(tripId, 'assistant', question, null, 'form_question');
  await addChatMessage(tripId, 'user', answer, null, 'form_answer');
}
