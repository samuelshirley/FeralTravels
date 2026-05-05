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
import { getUnitsPref } from '@/server/repos/users';
import { miToKm, type UnitsPref } from '@/lib/units';
import type { OnboardingState } from '@/types/trip';

// ---------------------------------------------------------------------------
// Onboarding is a deterministic form-in-chat that gathers everything Penny
// needs BEFORE the first real Anthropic call. The flow is:
//
//   not_started  → (has vehicles?)  yes → vehicle_pick     no → vehicle_new
//   vehicle_pick → (user picks existing) → link → ready
//                  (user picks "new")    → vehicle_new
//   vehicle_new  → iterate buildVehicleQuestions(unitsPref) → ready
//   ready        → single "where do you want to go?" question → done
//   done         → hand off to Penny (Anthropic), chat is live
//
// Keeping the question schema on the server (rather than hard-coding it in the
// client) means the canonical ordering + validation lives in one place; the
// client just renders whatever the server says is next.
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

/**
 * The canonical vehicle wizard. Order matters — Penny asks them top-to-bottom.
 *
 * Migration 0007 collapsed the old 14-question flow (make/model, dimensions,
 * full fuel breakdown, water capacities, notes) into seven targeted prompts.
 * The single non-obvious one is `refill_distance_km`: rather than ask for
 * fuel economy + tank size + reserve and back-compute an effective range,
 * we ask the user directly how far they like to drive between refuels.
 * That mirrors the way overlanders actually think about it ("I'll fill up
 * roughly every 400 km") and avoids forcing anyone to know their L/100km.
 *
 * Question text (and the `refill_distance_km` placeholder/limits) is unit-
 * aware: imperial users see "miles" and we convert miles → km on save.
 * Stored values are always metric.
 */
function buildVehicleQuestions(units: UnitsPref): Question[] {
  const isImperial = units === 'imperial';
  const distLabel = isImperial ? 'miles' : 'kilometers';
  const distPlaceholder = isImperial ? '250' : '400';
  // Bound the *displayed* range. `coerceAnswer` enforces these limits on
  // the value the user types; we convert mi → km only after validation.
  const distMin = isImperial ? 30 : 50;
  const distMax = isImperial ? 1500 : 2500;

  return [
    {
      key: 'name',
      kind: 'text',
      label: "What's the vehicle called? (just a nickname is fine)",
      placeholder: 'e.g. Duncan',
    },
    {
      key: 'refill_distance_km',
      kind: 'integer',
      label: `How far between fuel stops, in ${distLabel}?`,
      placeholder: distPlaceholder,
      help:
        'Tell me roughly how far you like to drive on a tank before refueling. ' +
        "I'll plan a fuel stop every ~that distance, regardless of your tank's actual capacity.",
      min: distMin,
      max: distMax,
    },
    {
      key: 'max_drive_hours_per_day',
      kind: 'number',
      label: 'Max hours you want to drive per day?',
      placeholder: '6',
      min: 1,
      max: 24,
    },
    {
      key: 'max_drive_hours_per_week',
      kind: 'number',
      label: 'Max hours per week?',
      placeholder: '30',
      min: 1,
      max: 100,
    },
    {
      key: 'max_consecutive_drive_days',
      kind: 'integer',
      label: 'Max consecutive driving days before a rest day?',
      placeholder: '3',
      min: 1,
      max: 14,
    },
    {
      key: 'water_refill_days',
      kind: 'integer',
      label: 'How many days between freshwater refills?',
      placeholder: '4',
      min: 1,
      max: 30,
      optional: true,
    },
    {
      key: 'blackwater_refill_days',
      kind: 'integer',
      label: 'How many days between black/grey water dumps?',
      placeholder: '5',
      min: 1,
      max: 30,
      optional: true,
    },
  ];
}

/**
 * Stable count of vehicle questions — used for the "3 of 7" progress label.
 * The list is the same length in metric and imperial; we just rebuild it
 * with the active labels. Hard-coded here so the UI doesn't need to call
 * buildVehicleQuestions() just to count.
 */
const VEHICLE_QUESTION_COUNT = 7;

export const HANDOFF_QUESTION: Question = {
  key: 'handoff',
  kind: 'handoff',
  label: "Where do you want to go? Tell me like you would a friend.",
  placeholder: 'e.g. Spain → Portugal over three weeks, leaving mid-June, chasing beaches and tapas',
  multiline: true,
};

// ---------------------------------------------------------------------------

export interface OnboardingSnapshot {
  state: OnboardingState;
  /** Next question to ask, or null if onboarding is done. */
  question: Question | null;
  /** For 'vehicle_pick', the candidate vehicles. */
  vehicles: Array<{ id: number; name: string; is_default: boolean }>;
  /** Progress counter — "3 of 16" style. */
  progress: { current: number; total: number } | null;
}

/**
 * What state should a brand-new trip be in? Depends on whether the user
 * already has vehicles to pick from.
 */
async function resolveStart(userId: string): Promise<OnboardingState> {
  const vehicles = await listVehiclesForUser(userId);
  return vehicles.length > 0 ? 'vehicle_pick' : 'vehicle_new';
}

/**
 * When we're in `vehicle_new`, figure out which question to ask next by
 * walking the active questions list and returning the first one that isn't resolved.
 *
 * "Resolved" means:
 *   - REQUIRED field with a non-null value on the vehicle row, OR
 *   - OPTIONAL field with a non-null value OR whose question label already
 *     appears in chat_history's form_question rows for this trip (i.e. the
 *     user was already shown the question and either answered or hit skip,
 *     resulting in a null column but a recorded question in chat).
 *
 * The `askedLabels` set is the fix for an earlier bug where optional
 * questions looped forever: the old code treated `optional === true` as
 * "always unfilled" and so the server re-asked `water_refill_days` on every
 * snapshot fetch, regardless of what the user typed or whether they hit
 * Skip. Using chat history as a source of truth means Skip actually sticks.
 */
function nextVehicleQuestion(
  vehicle: VehicleApi | null,
  askedLabels: Set<string>,
  questions: Question[]
): { question: Question; index: number } | null {
  if (!vehicle) {
    // Name is always first; we haven't even created the row yet.
    return { question: questions[0], index: 0 };
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const raw = (vehicle as unknown as Record<string, unknown>)[q.key];
    const hasValue = raw !== null && raw !== undefined && raw !== '';
    const resolved = q.optional ? hasValue || askedLabels.has(q.label) : hasValue;
    if (!resolved) return { question: q, index: i };
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

  // Bootstrap: pick a real state the first time we're asked.
  if (state === 'not_started') {
    state = await resolveStart(userId);
    await db
      .update(trips)
      .set({ onboardingState: state, updatedAt: new Date() })
      .where(eq(trips.id, tripId));
  }

  const vehicles = await listVehiclesForUser(userId);

  if (state === 'vehicle_pick') {
    return {
      state,
      question: {
        key: 'vehicle_pick',
        kind: 'vehicle_pick',
        label: 'Which vehicle are you taking on this trip?',
      },
      vehicles: vehicles.map((v) => ({
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
    const questions = buildVehicleQuestions(unitsPref);
    const next = nextVehicleQuestion(currentVehicle, askedLabels, questions);
    if (!next) {
      // All vehicle fields filled — advance to ready.
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
      progress: { current: next.index + 1, total: VEHICLE_QUESTION_COUNT },
    };
  }

  if (state === 'ready') {
    return { state, question: HANDOFF_QUESTION, vehicles: [], progress: null };
  }

  // 'preferences' is reserved for future use; for now it short-circuits to ready.
  if (state === 'preferences') {
    await db
      .update(trips)
      .set({ onboardingState: 'ready', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    return { state: 'ready', question: HANDOFF_QUESTION, vehicles: [], progress: null };
  }

  // 'done' — onboarding is over.
  return { state: 'done', question: null, vehicles: [], progress: null };
}

// ---------------------------------------------------------------------------

export interface SubmitAnswerInput {
  questionKey: string;
  value: unknown; // string | number | 'new' | vehicle id
}

export interface SubmitAnswerResult {
  next: OnboardingSnapshot;
  /**
   * Human-readable label we wrote into chat_history for the answer. The client
   * uses this to render the user bubble optimistically. Null if this is the
   * handoff answer (in which case the caller handles the Penny reply).
   */
  answerLabel: string;
  /** True when this answer just pushed state to 'done'. */
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

  // vehicle_pick
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
    await db
      .update(trips)
      .set({ vehicleId, onboardingState: 'ready', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    await writeQA(
      tripId,
      'Which vehicle are you taking on this trip?',
      `Using ${chosen.name}`
    );
    return {
      next: await getOnboardingSnapshot(tripId, userId),
      answerLabel: `Using ${chosen.name}`,
      didHandoff: false,
    };
  }

  // vehicle_new — write one field at a time.
  if (state === 'vehicle_new') {
    const unitsPref = await getUnitsPref(userId);
    const questions = buildVehicleQuestions(unitsPref);
    const question = questions.find((q) => q.key === input.questionKey);
    if (!question) throw new Error(`Unknown question ${input.questionKey}`);

    // Coerce + validate (in displayed units — miles for imperial users).
    const parsed = coerceAnswer(question, input.value);

    // First question ('name') creates the vehicle. Subsequent questions PATCH.
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
        // User answered in miles; storage is always km. miToKm preserves
        // null for skip/empty answers.
        const km = parsed == null ? null : miToKm(parsed as number);
        patch.refill_distance_km = km == null ? null : Math.round(km);
      } else {
        patch[question.key] = parsed;
      }
      await updateVehicle(userId, vehicle.id, patch);
    }

    const answerLabel = humanizeAnswer(question, parsed, unitsPref);
    await writeQA(tripId, question.label, answerLabel);

    // Check if that was the last field — advance to 'ready' if so.
    const afterSnapshot = await getOnboardingSnapshot(tripId, userId);
    return {
      next: afterSnapshot,
      answerLabel,
      didHandoff: false,
    };
  }

  // ready — the handoff. The caller (the API route) will trigger Penny's
  // first real message after we bump state to 'done'.
  if (state === 'ready' && input.questionKey === 'handoff') {
    const text = typeof input.value === 'string' ? input.value.trim() : '';
    if (!text) throw new Error('Please describe your trip.');
    await db
      .update(trips)
      .set({ onboardingState: 'done', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    // We DON'T write a form_question/form_answer for the handoff — the live
    // Penny conversation takes over, and the caller writes the user message
    // as kind='ai' before invoking replan. That keeps the hand-off message in
    // Penny's own context window.
    return {
      next: { state: 'done', question: null, vehicles: [], progress: null },
      answerLabel: text,
      didHandoff: true,
    };
  }

  throw new Error(`Cannot answer question "${input.questionKey}" in state "${state}"`);
}

// ---------------------------------------------------------------------------

function coerceAnswer(q: Question, raw: unknown): unknown {
  if (q.optional && (raw === null || raw === undefined || raw === '')) return null;

  switch (q.kind) {
    case 'text': {
      if (typeof raw !== 'string') throw new Error(`Expected string for ${q.key}`);
      return raw.trim();
    }
    case 'select': {
      if (typeof raw !== 'string') throw new Error(`Expected option for ${q.key}`);
      const valid = (q.options ?? []).some((o) => o.value === raw);
      if (!valid) throw new Error(`Invalid option for ${q.key}: ${raw}`);
      return raw;
    }
    case 'number':
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`Expected number for ${q.key}`);
      if (q.kind === 'integer' && !Number.isInteger(n)) {
        throw new Error(`Expected integer for ${q.key}`);
      }
      if (q.min !== undefined && n < q.min) {
        throw new Error(`${q.key} must be ≥ ${q.min}`);
      }
      if (q.max !== undefined && n > q.max) {
        throw new Error(`${q.key} must be ≤ ${q.max}`);
      }
      return n;
    }
    default:
      throw new Error(`Unhandled question kind ${q.kind}`);
  }
}

/**
 * Render the user's answer in a human-readable form for the chat bubble.
 * Unit suffixes are inferred from the question key so we don't need a
 * separate `unit` field on Question just for display. The refill-distance
 * suffix toggles with the user's units pref because the value the user
 * typed (and what we want to echo back) is in their chosen unit.
 */
const STATIC_UNIT_SUFFIX: Record<string, string> = {
  water_refill_days: ' days',
  blackwater_refill_days: ' days',
  max_drive_hours_per_day: ' h/day',
  max_drive_hours_per_week: ' h/week',
  max_consecutive_drive_days: ' days',
};

function humanizeAnswer(q: Question, value: unknown, units: UnitsPref): string {
  if (value === null || value === undefined || value === '') return '(skipped)';
  if (q.kind === 'select') {
    const opt = (q.options ?? []).find((o) => o.value === value);
    return opt?.label ?? String(value);
  }
  if (q.key === 'refill_distance_km') {
    return `${value}${units === 'imperial' ? ' mi' : ' km'}`;
  }
  return `${value}${STATIC_UNIT_SUFFIX[q.key] ?? ''}`;
}

async function writeQA(tripId: number, question: string, answer: string) {
  // Question first (assistant), then answer (user) — matches chronological
  // rendering in ChatPanel without any extra ordering logic.
  await addChatMessage(tripId, 'assistant', question, null, 'form_question');
  await addChatMessage(tripId, 'user', answer, null, 'form_answer');
}
