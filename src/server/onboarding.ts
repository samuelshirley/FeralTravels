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
  type VehicleFuelType,
} from '@/server/repos/vehicles';
import type { OnboardingState } from '@/types/trip';

// ---------------------------------------------------------------------------
// Onboarding is a deterministic form-in-chat that gathers everything Penny
// needs BEFORE the first real Anthropic call. The flow is:
//
//   not_started  → (has vehicles?)  yes → vehicle_pick     no → vehicle_new
//   vehicle_pick → (user picks existing) → link → ready
//                  (user picks "new")    → vehicle_new
//   vehicle_new  → iterate VEHICLE_QUESTIONS → ready
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
 * Keep required-for-fuel-planning fields (economy, tank) near the front so if
 * the user bails partway we at least have enough to plan safely.
 *
 * Intentionally dropped from the onboarding flow (columns still exist on the
 * vehicles row and can be edited from the profile settings page):
 *   - vehicle_type: only used as decorative context for Penny; no planning
 *     logic branches on it. Physical dimensions + fuel fields carry the
 *     functional signal.
 *   - length_m: matters for ferry pricing and campsite pitch caps, but we
 *     don't plan either today. Add back when we do.
 *
 * Height is asked in METERS (people don't think in cm for their rig). We
 * still store on the `height_cm` column to avoid a schema migration —
 * `submitAnswer` converts m → cm on write.
 */
export const VEHICLE_QUESTIONS: Question[] = [
  {
    key: 'name',
    kind: 'text',
    label: "What's the vehicle called? (just a nickname is fine)",
    placeholder: 'e.g. Duncan',
  },
  {
    key: 'fuel_type',
    kind: 'select',
    label: 'Fuel type?',
    options: [
      { value: 'diesel', label: 'Diesel' },
      { value: 'petrol', label: 'Petrol / Unleaded' },
      { value: 'premium', label: 'Premium' },
      { value: 'lpg', label: 'LPG' },
    ],
  },
  {
    key: 'fuel_economy_kmpl',
    kind: 'number',
    label: 'Fuel economy, in km per liter?',
    placeholder: '8',
    help: 'If you know L/100km, divide 100 by it — e.g. 12.5 L/100km ≈ 8 km/L.',
    min: 0.1,
    max: 100,
  },
  {
    key: 'fuel_tank_l',
    kind: 'number',
    label: 'Tank size in liters?',
    placeholder: '80',
    min: 1,
    max: 1000,
  },
  {
    key: 'height_m',
    kind: 'number',
    label: 'Vehicle height in meters?',
    placeholder: '2.3',
    help: 'Used to flag low-clearance routes. Round up if loaded.',
    min: 0.5,
    max: 5.0,
  },
  {
    key: 'weight_kg',
    kind: 'number',
    label: 'Loaded weight in kg?',
    placeholder: '2800',
    help: 'Ballpark is fine. Over 3500 kg pushes you off narrow tracks.',
    min: 100,
    max: 40000,
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
    key: 'freshwater_capacity_l',
    kind: 'number',
    label: 'Freshwater tank in liters? (0 if none)',
    placeholder: '100',
    min: 0,
    max: 2000,
  },
  {
    key: 'blackwater_capacity_l',
    kind: 'number',
    label: 'Blackwater / grey tank in liters? (0 if none)',
    placeholder: '80',
    min: 0,
    max: 2000,
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
    label: 'How many days between blackwater dumps?',
    placeholder: '5',
    min: 1,
    max: 30,
    optional: true,
  },
  {
    key: 'notes',
    kind: 'text',
    label: 'Any other notes about this vehicle? (optional — skip if not)',
    placeholder: '4WD with lockers, rooftop tent, solar…',
    optional: true,
    multiline: true,
  },
];

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
  vehicles: Array<{ id: number; name: string; is_default: boolean; vehicle_type: string | null }>;
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
 * walking VEHICLE_QUESTIONS and returning the first one that isn't resolved.
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
  askedLabels: Set<string>
): { question: Question; index: number } | null {
  if (!vehicle) {
    // Name is always first; we haven't even created the row yet.
    return { question: VEHICLE_QUESTIONS[0], index: 0 };
  }
  for (let i = 0; i < VEHICLE_QUESTIONS.length; i++) {
    const q = VEHICLE_QUESTIONS[i];
    // `height_m` is a pseudo-key — the stored column is height_cm. Read it
    // that way so a partially-populated vehicle advances correctly.
    const columnKey = q.key === 'height_m' ? 'height_cm' : q.key;
    const raw = (vehicle as unknown as Record<string, unknown>)[columnKey];
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
        vehicle_type: v.vehicle_type,
      })),
      progress: null,
    };
  }

  if (state === 'vehicle_new') {
    const currentVehicle = trip.vehicleId
      ? await getVehicleForUser(userId, trip.vehicleId)
      : null;
    const askedLabels = await loadAskedLabels(tripId);
    const next = nextVehicleQuestion(currentVehicle, askedLabels);
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
      progress: { current: next.index + 1, total: VEHICLE_QUESTIONS.length },
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
    const question = VEHICLE_QUESTIONS.find((q) => q.key === input.questionKey);
    if (!question) throw new Error(`Unknown question ${input.questionKey}`);

    // Coerce + validate.
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
      if (question.key === 'fuel_type') {
        patch.fuel_type = parsed as VehicleFuelType;
      } else if (question.key === 'height_m') {
        // UI asks in meters; the column stores cm. Round so integer-typed
        // downstream consumers don't choke on e.g. 230.0000001.
        patch.height_cm = parsed == null ? null : Math.round((parsed as number) * 100);
      } else {
        patch[question.key] = parsed;
      }
      await updateVehicle(userId, vehicle.id, patch);
    }

    await writeQA(tripId, question.label, humanizeAnswer(question, parsed));

    // Check if that was the last field — advance to 'ready' if so.
    const afterSnapshot = await getOnboardingSnapshot(tripId, userId);
    return {
      next: afterSnapshot,
      answerLabel: humanizeAnswer(question, parsed),
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
 * separate `unit` field on Question just for display.
 */
const UNIT_SUFFIX: Record<string, string> = {
  fuel_economy_kmpl: ' km/L',
  fuel_tank_l: ' L',
  height_m: ' m',
  weight_kg: ' kg',
  freshwater_capacity_l: ' L',
  blackwater_capacity_l: ' L',
  water_refill_days: ' days',
  blackwater_refill_days: ' days',
  max_drive_hours_per_day: ' h/day',
  max_drive_hours_per_week: ' h/week',
  max_consecutive_drive_days: ' days',
};

function humanizeAnswer(q: Question, value: unknown): string {
  if (value === null || value === undefined || value === '') return '(skipped)';
  if (q.kind === 'select') {
    const opt = (q.options ?? []).find((o) => o.value === value);
    return opt?.label ?? String(value);
  }
  return `${value}${UNIT_SUFFIX[q.key] ?? ''}`;
}

async function writeQA(tripId: number, question: string, answer: string) {
  // Question first (assistant), then answer (user) — matches chronological
  // rendering in ChatPanel without any extra ordering logic.
  await addChatMessage(tripId, 'assistant', question, null, 'form_question');
  await addChatMessage(tripId, 'user', answer, null, 'form_answer');
}
