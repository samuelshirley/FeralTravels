import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { chatHistory, trips, users } from '@/server/db/schema';
import { addChatMessage } from '@/server/repos/chat';
import {
  addVehicle,
  getVehicleForUser,
  listVehiclesForUser,
  updateVehicle,
  type VehicleApi,
} from '@/server/repos/vehicles';
import { getUnitsPref, getRawUnitsPref, setUnitsPref } from '@/server/repos/users';
import { extractDateFromText, formatDate, parseISODate, todayISO } from '@/lib/dates';
import { resolveStartDate } from '@/server/parseStartDate';
import { estimateRange } from '@/server/parseRangeEstimate';
import { scanFirstMessage } from '@/server/onboardingIntentScan';
import { miToKm, kmToMi } from '@/lib/units';
import type { UnitsPref } from '@/lib/units';
import type { OnboardingState, OnboardingScan } from '@/types/trip';
import { getAccountVerdict, trialDaysRemaining } from '@/server/payments';
import { trialWelcomeLine } from '@/server/payments/copy';
import {
  buildVehicleProfileQuestions,
  coerceVehicleProfileValue,
  humanizeVehicleProfileAnswer,
  vehicleProfileQuestionAllowsNull,
  type VehicleProfileQuestion,
} from '@/lib/vehicleProfile';

// ---------------------------------------------------------------------------
// Onboarding is a deterministic form-in-chat that gathers everything Penny
// needs BEFORE the first real Anthropic call. Flow:
//
//   not_started  → trip_intent (Penny greeting + "where do you want to go?")
//   trip_intent  → units_pick (if units_pref NULL) | else vehicle_new
//   units_pick   → metric/imperial persisted → vehicle_new
//   vehicle_new  → profile questions + caravan gate → done (handoff)
//
// There is no trip-naming step: the "+ New trip" button creates the trip with a
// placeholder name and Penny renames it to its route during planning. Legacy
// rows still parked in the removed `trip_name` state are advanced on read.
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
  /**
   * Answer CHIPS: tappable options that submit immediately, alongside a
   * composer that still accepts free text. Distinct from 'select', which is
   * options ONLY — the date step needs both, because "next Saturday" is a
   * chip and "the second week of June" is not.
   */
  | 'chips'
  /**
   * The composite first-run vehicle card (frame 7e): the nickname and the
   * range asked TOGETHER, answered by one submit. It exists because they were
   * two consecutive steps for one object, and the second of them is the only
   * number the fuel planner rests on — putting them on one card is what lets
   * the range carry its chips and its "work it out for me" escape hatch
   * without the setup feeling like an interrogation.
   *
   * It is offered ONLY when both halves are empty. A vehicle that already has
   * a name and needs only a range — which is what `range_help` returns to, and
   * what the validation fixture seeds — still gets the single `chips` step.
   */
  | 'vehicle'
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
  /** Prefilled answer (e.g. a start date extracted from the trip description). */
  defaultValue?: string;
  /**
   * Tappable example answers that PREFILL the composer and focus it — they do
   * NOT submit. That difference is the whole point: an `option` is an answer
   * to this question, a `prompt` is a shape to edit. The first message of a
   * trip is never something a user wants sent verbatim.
   */
  prompts?: string[];
  /**
   * One line under the chips explaining where a `defaultValue` came from, e.g.
   * that the date was read out of the user's own message. Rendered small and
   * quiet; omitted when nothing was inferred.
   */
  footnote?: string;
  /**
   * For `kind: 'vehicle'` only — the NAME half of the composite card. The
   * range half reuses this question's own `label`, `options`, `min`, `max`,
   * `placeholder` and `help`, so the two halves cannot describe their bounds
   * differently and the single-step `chips` question stays the one definition
   * of what a valid range is.
   */
  nameField?: { label: string; placeholder?: string };
}

// ---------------------------------------------------------------------------
// Onboarding questions
// ---------------------------------------------------------------------------

export const TRIP_INTENT_QUESTION: Question = {
  key: 'trip_intent',
  kind: 'handoff',
  /*
   * 69 words became 15. The old greeting introduced Penny, explained the three
   * accepted input formats, described what it would build, and warned that
   * more questions were coming — all before the user had said anything. The
   * three prompt rows below now demonstrate the formats in less space than
   * listing them took, and the questions announce themselves when they arrive.
   */
  label: "Where are we going? One city is enough to start — I'll sort the fuel.",
  placeholder: 'Where to?',
  multiline: true,
  prompts: [
    'Paris to Stuttgart, 5 h days',
    'Pyrenees loop with 3 rest days',
  ],
};

/** @deprecated Kept for backwards compatibility with old onboarding states. */
export const HANDOFF_QUESTION = TRIP_INTENT_QUESTION;

// Forced start-date question. Every trip must pin to a real calendar day —
// leg dates, the nightly replan, deadlines and the "behind you" collapse all
// depend on it (see Trip.start_date_parsed). The answer is free text but must
// parse to an ISO date via tryParseToISO, otherwise we re-ask.
export const TRIP_DATE_QUESTION: Question = {
  key: 'trip_date',
  /*
   * Chips, not text. The examples that used to be listed inside the question
   * ("November 1st", "next Saturday", "2026-06-03") are the answers now — and
   * `kind: 'chips'` keeps the composer live, because a chip cannot express
   * "the second week of June" and the step must not become a dead end.
   *
   * "Not sure yet" routes to TRIP_DATE_CLARIFY_QUESTION rather than refusing,
   * which is the same escape hatch the free-text path already had.
   */
  kind: 'chips',
  label: 'When are you setting off?',
  placeholder: 'e.g. November 1st, or 2026-06-03',
  options: [
    { value: 'next Saturday', label: 'Next Saturday' },
    { value: 'in a month', label: 'In a month' },
    { value: 'not sure yet', label: 'Not sure yet' },
  ],
};

// Shown once when the user gives NO usable date at all ("no idea yet"). We can't
// store null (it breaks every downstream date calc + the itinerary view), so we
// nudge for a rough timeframe and pick a date from it. If they still give
// nothing, the handler falls back to starting today. Same `key` as
// TRIP_DATE_QUESTION so the answer routes back through the trip_date branch.
export const TRIP_DATE_CLARIFY_QUESTION: Question = {
  key: 'trip_date',
  kind: 'text',
  label:
    "No worries if it's not locked in — roughly what time of year are you thinking? Even \"next summer\" or \"around Christmas\" works, and I'll pencil in a date you can refine later.",
  placeholder: 'e.g. next summer, around Christmas, early autumn',
};

// Shown when the driver can't give a fuel-range number on the
// range_km step. They describe what they DO know (vehicle, or tank +
// economy); estimateRange proposes a number they then confirm. Same
// `range_help` state both on entry and on a follow-up answer.
export const RANGE_HELP_QUESTION: Question = {
  key: 'range_help',
  kind: 'text',
  label:
    "No problem — tell me what you do know and I'll work it out. Your vehicle's " +
    'make, model and year (e.g. "2018 Toyota Hilux diesel"), or your tank size and ' +
    'rough fuel economy. I\'ll suggest a fuel range you can tweak.',
  placeholder: 'e.g. 2018 Toyota Hilux, or 80 L tank at ~11 km/L',
  multiline: true,
};

const UNITS_PREF_KEY = 'units_pref';

/** True when a value can't be read as a usable positive number (→ range help). */
function isNonNumericRangeAnswer(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (t === '') return false;
  const n = Number(t);
  return !Number.isFinite(n) || n <= 0;
}

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

function buildOnboardingSteps(units: UnitsPref): VehicleProfileQuestion[] {
  return buildVehicleProfileQuestions(units);
}

/** The key the composite card answers under. Not a vehicle column. */
export const VEHICLE_SETUP_KEY = 'vehicle_setup';

/**
 * The composite name+range card (frame 7e), BUILT FROM the two single steps
 * rather than restating them. That is deliberate: the range half's chips,
 * bounds and help text have exactly one definition
 * (`buildVehicleProfileQuestions`), so this card and the single `range_km`
 * step can never disagree about what a valid range is — and a units change
 * moves both at once.
 */
function buildVehicleSetupQuestion(units: UnitsPref): Question {
  const [nameQ, rangeQ] = buildVehicleProfileQuestions(units);
  return {
    key: VEHICLE_SETUP_KEY,
    kind: 'vehicle',
    label: rangeQ.label,
    placeholder: rangeQ.placeholder,
    help: rangeQ.help,
    options: rangeQ.options?.map((o) => ({ value: o.value, label: o.label })),
    min: rangeQ.min,
    max: rangeQ.max,
    nameField: { label: nameQ.label, placeholder: nameQ.placeholder },
    footnote: 'Change either of these any time in Settings.',
  };
}

function vehicleHasProfileValue(vehicle: VehicleApi, key: string): boolean {
  const raw = (vehicle as unknown as Record<string, unknown>)[key];
  return raw !== null && raw !== undefined && raw !== '';
}

/**
 * Determine the next state after trip_intent: units_pick (if not yet chosen),
 * or straight to vehicle_new (new users always create a vehicle).
 */
async function resolvePostIntentState(userId: string): Promise<OnboardingState> {
  const unitsChosen = (await getRawUnitsPref(userId)) != null;
  return unitsChosen ? 'vehicle_new' : 'units_pick';
}

/**
 * When we're in `vehicle_new`, walk the vehicle-profile questions (name +
 * fuel range) in order. See `loadAskedLabels` for
 * optional-field / skip behavior.
 */
function nextVehicleOnboardingQuestion(
  vehicle: VehicleApi | null,
  askedLabels: Set<string>,
  unitsPref: UnitsPref
): { question: Question; progress: { current: number; total: number } } | null {
  const questions = buildVehicleProfileQuestions(unitsPref);

  /*
   * BOTH halves empty ⇒ one composite card, and it counts as ONE step.
   *
   * `total` is computed here rather than from `questions.length` because the
   * progress counter is a promise to the user about how much is left; showing
   * "2 of 3" on a card that finishes the setup is the kind of small lie that
   * makes the rest of the numbers untrustworthy.
   *
   * The condition is deliberately "neither is set" and not "no vehicle": a
   * vehicle row can exist with a name and no range — `range_help` returns to
   * exactly that state, and the validation fixture seeds it — and re-asking
   * for a name already given would be worse than the two steps this replaces.
   */
  const nameMissing = !vehicle || !vehicleHasProfileValue(vehicle, 'name');
  const rangeMissing = !vehicle || !vehicleHasProfileValue(vehicle, 'range_km');
  if (nameMissing && rangeMissing) {
    return {
      question: buildVehicleSetupQuestion(unitsPref),
      progress: { current: 1, total: 1 },
    };
  }

  const total = questions.length;

  if (!vehicle) {
    return {
      question: questions[0] as Question,
      progress: { current: 1, total },
    };
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const hasVal = vehicleHasProfileValue(vehicle, q.key);
    const resolved = q.optional ? hasVal || askedLabels.has(q.label) : hasVal;
    if (!resolved) {
      return {
        question: q as Question,
        progress: { current: i + 1, total },
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

  // Stamp the user-level flag the first time only. `onConflict`-free because
  // this is the single place onboarding can complete, and `IS NULL` keeps a
  // second trip's onboarding from rewriting when they actually finished.
  if (trip?.userId) {
    await db
      .update(users)
      .set({ onboardingCompletedAt: new Date() })
      .where(and(eq(users.id, trip.userId), isNull(users.onboardingCompletedAt)));
  }
  // Clear pendingIntent + scan stash now that we're handing off
  await db
    .update(trips)
    .set({
      onboardingState: 'done',
      pendingIntent: null,
      onboardingScan: null,
      updatedAt: new Date(),
    })
    .where(eq(trips.id, tripId));
  return {
    next: { state: 'done', question: null, vehicles: [], progress: null },
    answerLabel: '',
    didHandoff: true,
    tripIntent: pendingIntent,
  };
}

/**
 * "I don't know my fuel range" helper. Takes whatever the driver knows
 * (vehicle, or tank + economy), asks the estimator for a CONSERVATIVE number,
 * and routes them back to the normal range_km step PREFILLED with
 * that estimate so they confirm or edit it — the estimate is never persisted
 * here (lockdown: the LLM proposes, the driver + the existing submit path own
 * the stored number).
 *
 * `alreadyInHelp` is false on the first miss (so we ask one focused follow-up)
 * and true once we've already asked (so a second miss falls back to "just type a
 * number" rather than looping — there is no safe default for range).
 */
async function runRangeHelp(
  tripId: string,
  userId: string,
  text: string,
  unitsPref: UnitsPref,
  alreadyInHelp: boolean,
): Promise<SubmitAnswerResult> {
  const isImperial = unitsPref === 'imperial';
  const unit = isImperial ? 'mi' : 'km';
  await addChatMessage(tripId, 'user', text, null, 'form_answer');

  const { km, basis } = await estimateRange(text, { userId, tripId });

  if (km != null) {
    await db
      .update(trips)
      .set({ onboardingState: 'vehicle_new', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    const shown = isImperial ? Math.round(kmToMi(km)!) : km;
    const snap = await getOnboardingSnapshot(tripId, userId);
    if (snap.question && snap.question.key === 'range_km') {
      snap.question = {
        ...snap.question,
        defaultValue: String(shown),
        label:
          `Going off ${basis || 'what you told me'}, I'd suggest a fuel range of ` +
          `about ${shown} ${unit} — send to confirm, or type your own number.`,
      };
    }
    const note =
      `Based on ${basis || 'that'}, about ${shown} ${unit} looks like a fuel range. ` +
      `Send to confirm, or change it if you know better.`;
    await addChatMessage(tripId, 'assistant', note, null, 'ai');
    return { next: snap, answerLabel: text, didHandoff: false, note };
  }

  if (!alreadyInHelp) {
    await db
      .update(trips)
      .set({ onboardingState: 'range_help', updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    await addChatMessage(tripId, 'assistant', RANGE_HELP_QUESTION.label, null, 'form_question');
    return {
      next: { state: 'range_help', question: RANGE_HELP_QUESTION, vehicles: [], progress: null },
      answerLabel: text,
      didHandoff: false,
    };
  }

  // Still not enough to estimate — stop guessing. No safe default exists for
  // range, so route back and let the driver enter a number directly.
  await db
    .update(trips)
    .set({ onboardingState: 'vehicle_new', updatedAt: new Date() })
    .where(eq(trips.id, tripId));
  const snap = await getOnboardingSnapshot(tripId, userId);
  const note =
    `No worries — just give me your best guess for how far you'd happily drive before ` +
    `refuelling, in ${unit}.`;
  await addChatMessage(tripId, 'assistant', note, null, 'ai');
  return { next: snap, answerLabel: text, didHandoff: false, note };
}

/**
 * If the upcoming vehicle question is a fuel-range field and the first-message
 * scan stashed an (already validated) value for it, prefill that value for the
 * driver to confirm with one tap. Confirm-don't-assume: the range is a safety
 * number, so it's surfaced for confirmation, never silently committed. Skips
 * prefill once the vehicle already holds the value. Returns the question
 * unchanged when there's nothing to prefill.
 */
function prefillRangeFromScan(
  question: Question,
  vehicle: VehicleApi | null,
  scan: OnboardingScan | null,
  unitsPref: UnitsPref,
): Question {
  if (!scan) return question;
  const isImperial = unitsPref === 'imperial';
  const unit = isImperial ? 'mi' : 'km';
  const toShown = (km: number) => (isImperial ? Math.round(kmToMi(km)!) : km);

  if (
    question.key === 'range_km' &&
    scan.range_km != null &&
    !(vehicle && vehicleHasProfileValue(vehicle, 'range_km'))
  ) {
    const shown = toShown(scan.range_km);
    return {
      ...question,
      defaultValue: String(shown),
      label:
        `From your description it sounds like about ${shown} ${unit} on a tank — ` +
        `send to confirm, or type your own number.`,
    };
  }

  return question;
}

// ---------------------------------------------------------------------------
// Snapshot: returns the current onboarding question for a trip
// ---------------------------------------------------------------------------

/**
 * Prepend the trial line to Penny's greeting, for users actually on a trial.
 *
 * The trial is announced by Penny, in the first thing she says, and nowhere
 * else — there is no welcome modal and no banner. A user who has already
 * subscribed, or who is comped, must never read about a trial they are not on,
 * which is why this asks the entitlement module rather than checking an age.
 *
 * Deliberately NOT baked into `TRIP_INTENT_QUESTION`: that constant is what
 * `writeQA` persists into `chat_history` when the user answers, and a
 * transcript that says "welcome to your seven-day free trial" forever, on a
 * trip they open two years later, would be a small lie of the kind this
 * codebase has had to go back and fix before. The greeting is the durable
 * thing; the trial line is true only right now.
 */
async function withTrialWelcome(question: Question, userId: string): Promise<Question> {
  try {
    const verdict = await getAccountVerdict(userId);
    if (verdict.state !== 'trial') return question;
    const line = trialWelcomeLine(trialDaysRemaining(new Date(), addDays(verdict.trialEndsAt, -7)));
    if (!line) return question;
    return { ...question, label: `${line} ${question.label}` };
  } catch {
    // The greeting must render even if the entitlement lookup fails. A user
    // who cannot be told about their trial is a worse outcome than a user who
    // is not told about it.
    return question;
  }
}

function addDays(d: Date | null, n: number): Date {
  const base = d ?? new Date();
  return new Date(base.getTime() + n * 24 * 60 * 60 * 1000);
}

/**
 * How many numbered steps this user's onboarding has.
 *
 * Extracted because the count was being derived in TWO places — the snapshot
 * path and the submit path — and they disagreed: one returned a number for the
 * date-clarify turn and the other returned null, so the progress pill vanished
 * on that turn and came back on reload.
 */
async function totalOnboardingSteps(userId: string): Promise<number> {
  const unitsAlreadyChosen = (await getRawUnitsPref(userId)) != null;
  const preVehicleSteps = 2 + (unitsAlreadyChosen ? 0 : 1);
  const vehicleSteps = buildOnboardingSteps(
    unitsAlreadyChosen ? await getUnitsPref(userId) : 'metric'
  );
  return preVehicleSteps + vehicleSteps.length;
}

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

  // Pre-vehicle steps: trip_intent + units_pick (if not yet set). We count
  // them so the progress bar reflects the full onboarding, not just the
  // vehicle-profile portion.
  const unitsAlreadyChosen = (await getRawUnitsPref(userId)) != null;
  /*
   * trip_intent IS step 1 now. It used to be excluded as "the greeting", which
   * made the header read "1 OF 4" on the SECOND question and left the first
   * with no progress at all — the one screen where a user most wants to know
   * how long this will take.
   *
   * Numbered: trip_intent + trip_date + units_pick (when not already chosen)
   * + the vehicle steps.
   */
  const unitSteps = unitsAlreadyChosen ? 0 : 1;
  const preVehicleSteps = 2 + unitSteps;

  if (state === 'trip_intent') {
    const vehicleStepsForIntent = buildOnboardingSteps(
      unitsAlreadyChosen ? await getUnitsPref(userId) : 'metric'
    );
    return {
      state: 'trip_intent',
      question: await withTrialWelcome(TRIP_INTENT_QUESTION, userId),
      vehicles: [],
      progress: { current: 1, total: preVehicleSteps + vehicleStepsForIntent.length },
    };
  }

  // Compute total for progress: preVehicleSteps + vehicle profile steps.
  // We need units pref for vehicle questions — use 'metric' as default since
  // we might not know yet, but the count is the same either way.
  const vehicleSteps = buildOnboardingSteps(unitsAlreadyChosen ? await getUnitsPref(userId) : 'metric');
  const totalSteps = preVehicleSteps + vehicleSteps.length;

  if (state === 'trip_date') {
    // If we've already nudged for a rough timeframe (the user first answered
    // "no idea"), keep showing that clarifying question on reload rather than
    // the original prompt.
    const clarifyAsked = (await loadAskedLabels(tripId)).has(
      TRIP_DATE_CLARIFY_QUESTION.label,
    );
    if (clarifyAsked) {
      return {
        state: 'trip_date',
        question: TRIP_DATE_CLARIFY_QUESTION,
        vehicles: [],
        /*
         * Step 2, same as the un-clarified date question. This returned null
         * before, so the progress pill VANISHED on the clarify turn and came
         * back on reload — a flicker with no meaning behind it.
         */
        progress: { current: 2, total: totalSteps },
      };
    }
    // If the user already mentioned a date in their trip description, prefill it
    // so confirming is one keystroke instead of retyping. They can still edit.
    const extracted = extractDateFromText(trip.pendingIntent ?? '');
    const question: Question = await (async (): Promise<Question> => {
      if (!extracted) return TRIP_DATE_QUESTION;
      const shown = formatDate(
        parseISODate(extracted),
        unitsAlreadyChosen ? await getUnitsPref(userId) : 'metric'
      );
      /*
       * A scanned date becomes the FIRST CHIP rather than a rewritten
       * question. The label used to carry the whole thing — "Looks like you're
       * setting off Wed 16 Sep — send to confirm, or type a different date" —
       * which is a question, an inference and two instructions in one
       * sentence. The question stays the question; the inference is a chip you
       * tap; the footnote says where it came from, so a wrong guess is
       * obviously a guess rather than something the app has decided.
       */
      return {
        ...TRIP_DATE_QUESTION,
        options: [
          { value: extracted, label: shown },
          ...(TRIP_DATE_QUESTION.options ?? []),
        ],
        footnote: `Read "${shown}" out of your message — tap to confirm, or say another.`,
        defaultValue: extracted,
      };
    })();
    return {
      state: 'trip_date',
      question,
      vehicles: [],
      // Step 2 — trip_intent is step 1 now, see the note above.
      progress: { current: 2, total: totalSteps },
    };
  }

  if (state === 'trip_name') {
    // Legacy: naming is no longer part of onboarding. Advance any trip still
    // parked in this state to the next real step.
    const nextState = await resolvePostIntentState(userId);
    await db
      .update(trips)
      .set({ onboardingState: nextState, updatedAt: new Date() })
      .where(eq(trips.id, tripId));
    return getOnboardingSnapshot(tripId, userId);
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
      // units_pick follows trip_date in the numbered pre-vehicle steps.
      progress: { current: preVehicleSteps, total: totalSteps },
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

  if (state === 'range_help') {
    // Interstitial: the driver couldn't give a range number and we're gathering
    // what they know so the estimator can propose one. Survives reload.
    return {
      state: 'range_help',
      question: RANGE_HELP_QUESTION,
      vehicles: [],
      progress: null,
    };
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
      // All vehicle questions answered — complete onboarding (and clear any
      // leftover scan stash; range was either consumed or never asked).
      await db
        .update(trips)
        .set({ onboardingState: 'done', onboardingScan: null, updatedAt: new Date() })
        .where(eq(trips.id, tripId));
      return { state: 'done', question: null, vehicles: [], progress: null };
    }
    // Prefill the fuel-range questions from the first-message scan stash so the
    // driver confirms an inferred range with one tap instead of retyping. The
    // value is already validated/in-band; we only convert to display units. This
    // is confirm-don't-assume — the safety number is never silently committed.
    const question = prefillRangeFromScan(
      next.question,
      currentVehicle,
      trip.onboardingScan as OnboardingScan | null,
      unitsPref,
    );
    // Offset vehicle progress by the pre-vehicle steps so the counter
    // reflects the full onboarding flow ([units_pick] + vehicle).
    return {
      state,
      question,
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
  /**
   * Deterministic one-line acknowledgment for the client to render as a Penny
   * bubble (e.g. the trip_date step confirming the date, or telling the user a
   * placeholder was used). Composed by the form, NOT the LLM.
   */
  note?: string;
}

export async function submitAnswer(
  tripId: string,
  userId: string,
  input: SubmitAnswerInput
): Promise<SubmitAnswerResult> {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip || trip.userId !== userId) throw new Error('Trip not found');
  const state = trip.onboardingState as OnboardingState;

  // ---- Range help follow-up ("I don't know my range" → estimate + confirm) ----
  if (state === 'range_help') {
    const text = typeof input.value === 'string' ? input.value.trim() : '';
    if (!text) throw new Error('Tell me a bit about your vehicle or tank so I can help.');
    const unitsPref = await getUnitsPref(userId);
    return runRangeHelp(tripId, userId, text, unitsPref, true);
  }

  // ---- Trip intent (first question) ----
  if (state === 'trip_intent' && input.questionKey === 'trip_intent') {
    const text = typeof input.value === 'string' ? input.value.trim() : '';
    if (!text) throw new Error('Please describe your trip.');

    // First-message intent scan: read the opening description for onboarding
    // variables the driver already gave (start date, fuel range) so we can skip
    // or prefill those questions. The LLM only transcribes; every field is
    // re-validated below. Never throws — an all-null result just means we fall
    // through to asking everything as before.
    const scan = await scanFirstMessage(text, { userId, tripId });

    // Record the opening Q/A bubble.
    await writeQA(tripId, TRIP_INTENT_QUESTION.label, text);

    // Stash validated prefill-confirm fields (fuel range is a safety number — the
    // driver confirms it on the vehicle step, so it waits in onboardingScan
    // rather than being committed here). See OnboardingScan.
    const scanStash: OnboardingScan = {};
    if (scan.rangeKm != null) scanStash.range_km = scan.rangeKm;

    const patch: Record<string, unknown> = {
      pendingIntent: text,
      onboardingScan: Object.keys(scanStash).length > 0 ? scanStash : null,
      updatedAt: new Date(),
    };

    // An EXACT start date in the opening message ("leaving tomorrow", "next
    // Saturday") is applied now and its question SKIPPED — the headline fix. A
    // VAGUE/assumed date ("this summer") is NOT auto-committed: it falls through
    // to the trip_date step so the driver confirms (confirm-don't-assume on a
    // low-confidence date, mirroring the typed-date path).
    let note: string | undefined;
    const exactIso =
      scan.startDate && !scan.startDate.assumed ? scan.startDate.iso : null;
    if (exactIso) {
      patch.startDate = scan.startDatePhrase ?? text;
      patch.startDateParsed = exactIso;
      patch.onboardingState = await resolvePostIntentState(userId);
      const unitsForFmt =
        (await getRawUnitsPref(userId)) != null ? await getUnitsPref(userId) : 'metric';
      note = `Got it — setting off ${formatDate(parseISODate(exactIso), unitsForFmt)}.`;
    } else {
      // Always ask for a start date next — it's a hard invariant. Penny names the
      // trip from its route once planning begins (no naming step here).
      patch.onboardingState = 'trip_date';
    }

    await db.update(trips).set(patch).where(eq(trips.id, tripId));
    if (note) await addChatMessage(tripId, 'assistant', note, null, 'ai');

    // A returning user (units + vehicle already set) who gave an exact date may
    // now be fully onboarded — complete the handoff so the client fires the
    // stored intent at Penny instead of stalling on a finished wizard.
    const afterSnapshot = await getOnboardingSnapshot(tripId, userId);
    if (afterSnapshot.state === 'done') {
      return { ...(await completeOnboarding(tripId)), note };
    }
    return {
      next: afterSnapshot,
      answerLabel: text,
      didHandoff: false,
      note,
    };
  }

  // ---- Start date (forced; must parse to a real calendar day) ----
  if (state === 'trip_date' && input.questionKey === 'trip_date') {
    const text = typeof input.value === 'string' ? input.value.trim() : '';
    if (!text) throw new Error('Please enter a start date.');
    // Deterministic parse first; the LLM converts the rest to a real day —
    // pinning a specific day, or picking a representative day inside a vague
    // timeframe ("this summer", assumed). iso is null ONLY when there's no
    // temporal signal at all ("no idea yet").
    const clarifyAsked = (await loadAskedLabels(tripId)).has(
      TRIP_DATE_CLARIFY_QUESTION.label,
    );
    // Record the answer under whichever question the user was actually shown.
    const askedLabel = clarifyAsked
      ? TRIP_DATE_CLARIFY_QUESTION.label
      : TRIP_DATE_QUESTION.label;
    const { iso, assumed } = await resolveStartDate(text, { userId, tripId });

    // No usable date AND we haven't nudged yet → ask ONE clarifying question and
    // stay on the step. We never persist null; if they still give nothing next
    // time, the branch below falls back to starting today.
    if (iso === null && !clarifyAsked) {
      await writeQA(tripId, askedLabel, text);
      await addChatMessage(
        tripId,
        'assistant',
        TRIP_DATE_CLARIFY_QUESTION.label,
        null,
        'form_question',
      );
      return {
        next: {
          state: 'trip_date',
          question: TRIP_DATE_CLARIFY_QUESTION,
          vehicles: [],
          /*
           * Still step 2. This was null, so the progress pill vanished the
           * moment a user said "no idea yet" and reappeared if they reloaded —
           * the reload path (getOnboardingSnapshot) always returned a number.
           * Two code paths for one screen, disagreeing.
           */
          progress: { current: 2, total: await totalOnboardingSteps(userId) },
        },
        answerLabel: text,
        didHandoff: false,
      };
    }

    // From here we always have a date: the resolved one, or — when the user
    // still gave no signal after the nudge — today as a last resort. NEVER null.
    const noSignal = iso === null;
    const finalIso = iso ?? todayISO();
    const nextState = await resolvePostIntentState(userId);
    await db
      .update(trips)
      .set({
        // Keep the user's original phrasing in the free-text column, store the
        // machine date in start_date_parsed (the invariant the app relies on).
        startDate: text,
        startDateParsed: finalIso,
        onboardingState: nextState,
        updatedAt: new Date(),
      })
      .where(eq(trips.id, tripId));
    // The form answer bubble shows what the user actually typed; the
    // acknowledgment below carries the resolved date. When we'd already shown
    // the clarify question, its row was persisted when we asked it — so just
    // record the answer rather than writing the question again (avoids a dupe).
    if (clarifyAsked) {
      await addChatMessage(tripId, 'user', text, null, 'form_answer');
    } else {
      await writeQA(tripId, askedLabel, text);
    }

    // Deterministic acknowledgment — this is the JS form talking, not Penny's
    // LLM. Three cases: confirmed exact date, assumed-from-timeframe, or the
    // "still no idea → start today" fallback.
    const unitsForFmt =
      (await getRawUnitsPref(userId)) != null
        ? await getUnitsPref(userId)
        : 'metric';
    const formatted = formatDate(parseISODate(finalIso), unitsForFmt);
    const note = noSignal
      ? `No worries — I'll start you off today. Just tell me your real start date whenever you've got it and I'll shift the whole plan.`
      : assumed
        ? `No problem — I'll pencil in ${formatted} for now. Just tell me your real start date whenever you've got it and I'll shift the plan.`
        : `Great — ${formatted} it is.`;
    await addChatMessage(tripId, 'assistant', note, null, 'ai');

    const afterSnapshot = await getOnboardingSnapshot(tripId, userId);
    // A returning user with units + vehicle already set jumps straight to
    // 'done' — complete the handoff so the client fires the stored intent at
    // Penny instead of stalling on a finished wizard.
    if (afterSnapshot.state === 'done') {
      return { ...(await completeOnboarding(tripId)), note };
    }
    return {
      next: afterSnapshot,
      answerLabel: text,
      didHandoff: false,
      note,
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
    const afterSnapshot = await getOnboardingSnapshot(tripId, userId);
    // Returning user with vehicle already set: onboarding may jump straight
    // to 'done' after units are chosen. Complete the handoff so the client
    // fires the stored trip intent at Penny.
    if (afterSnapshot.state === 'done') {
      return completeOnboarding(tripId);
    }
    return {
      next: afterSnapshot,
      answerLabel,
      didHandoff: false,
    };
  }

  // ---- Vehicle new / profile questions ----
  if (state === 'vehicle_new') {
    const unitsPref = await getUnitsPref(userId);
    const questions = buildVehicleProfileQuestions(unitsPref);

    /*
     * THE COMPOSITE CARD (frame 7e) — name and range in one submit.
     *
     * It reuses the SINGLE steps' question objects for validation rather than
     * re-deriving bounds, so there is still exactly one definition of a legal
     * range and the two surfaces cannot drift apart. The server re-validates
     * the whole object regardless of what the client sent: the composite is a
     * rendering decision, not a relaxation of the boundary.
     *
     * "I don't know" still works. The name is persisted FIRST and then the
     * range routes to `range_help` exactly as it does on the single step —
     * which is why the walker's composite condition is "neither is set": with
     * a name on the row, the helper returns to the range-only question and the
     * user is never asked to name the vehicle twice.
     */
    if (input.questionKey === VEHICLE_SETUP_KEY) {
      const [nameQ, rangeQ] = questions;
      const raw = input.value;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Expected a name and a range.');
      }
      const { name: rawName, range_km: rawRange } = raw as Record<string, unknown>;

      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name) throw new Error('This field is required.');

      let vehicleForSetup: VehicleApi | null = trip.vehicleId
        ? await getVehicleForUser(userId, trip.vehicleId)
        : null;
      if (!vehicleForSetup) {
        vehicleForSetup = await addVehicle(userId, { name, is_default: false });
        await db
          .update(trips)
          .set({ vehicleId: vehicleForSetup.id, updatedAt: new Date() })
          .where(eq(trips.id, tripId));
      } else {
        await updateVehicle(userId, vehicleForSetup.id, { name });
      }
      await writeQA(tripId, nameQ.label, name);

      // Non-numeric range ⇒ the helper, with the name already safe.
      if (isNonNumericRangeAnswer(rawRange)) {
        return runRangeHelp(tripId, userId, rawRange.trim(), unitsPref, false);
      }
      if (rawRange === null || rawRange === undefined || rawRange === '') {
        throw new Error('This field is required.');
      }

      const parsedRange = coerceVehicleProfileValue(rangeQ, rawRange);
      const shown = parsedRange as number;
      if (!Number.isFinite(shown)) throw new Error('Please enter a number.');
      if (rangeQ.min !== undefined && shown < rangeQ.min) {
        throw new Error(`Must be at least ${rangeQ.min}.`);
      }
      if (rangeQ.max !== undefined && shown > rangeQ.max) {
        throw new Error(`Must be at most ${rangeQ.max}.`);
      }

      const km = unitsPref === 'imperial' ? Math.round(miToKm(shown)!) : shown;
      await updateVehicle(userId, vehicleForSetup.id, { range_km: km });

      const rangeLabel = humanizeVehicleProfileAnswer(rangeQ, shown, unitsPref);
      await writeQA(tripId, rangeQ.label, rangeLabel);

      const after = await getOnboardingSnapshot(tripId, userId);
      if (after.state === 'done') return completeOnboarding(tripId);
      return { next: after, answerLabel: `${name} · ${rangeLabel}`, didHandoff: false };
    }

    const question = questions.find((q) => q.key === input.questionKey);
    if (!question) throw new Error(`Unknown question ${input.questionKey}`);

    let vehicle: VehicleApi | null = trip.vehicleId
      ? await getVehicleForUser(userId, trip.vehicleId)
      : null;

    // "I don't know" on the fuel-range step → branch to the range helper
    // instead of erroring on non-numeric input. (Name is captured first, so a
    // vehicle row already exists by the time we reach this question.)
    if (
      input.questionKey === 'range_km' &&
      vehicle &&
      isNonNumericRangeAnswer(input.value)
    ) {
      return runRangeHelp(tripId, userId, input.value.trim(), unitsPref, false);
    }

    const vehicleRecord = (vehicle ?? {}) as unknown as Record<string, unknown>;
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
      if (question.key === 'range_km' && unitsPref === 'imperial') {
        const km = parsed == null ? null : miToKm(parsed as number);
        patch.range_km = km == null ? null : Math.round(km);
      } else {
        patch[question.key] = parsed;
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
