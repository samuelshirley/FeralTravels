/**
 * The onboarding form's shared vocabulary — the parts BOTH clients and the
 * server have to agree on, kept in one DOM-free module so they cannot drift.
 * Mirrored to mobile/shared/lib by scripts/sync-shared.mjs.
 *
 * Two things live here, and each is here because it drifted once:
 *
 * 1. WHICH QUESTION KINDS ARE ANSWERED BY TAPPING. The chip row used to be
 *    rendered for `select || chips` while the tap handler bailed on anything
 *    but `select` — so the date step drew three chips that did nothing
 *    (2026-09-04). A renderer and a handler that each spell out the list will
 *    disagree again the next time a kind is added; both now read
 *    `TAP_TO_ANSWER_KINDS`, so a kind that renders chips is by construction a
 *    kind the handler accepts.
 *
 * 2. THE QUESTION LABELS. The progress counter decides which steps are IN a
 *    flow by recognising the `form_question` rows already in `chat_history`,
 *    and those rows carry only `content` — so the labels are defined here and
 *    imported by the server, rather than defined on the server and
 *    pattern-matched from memory elsewhere.
 *
 * 3. HOW AN ANSWERED STEP REDRAWS ITSELF. `buildFormMeta` writes the widget
 *    down and `collapseOnboardingSteps` folds the pair of rows back into one.
 *    Both are here rather than in either ChatPanel because the SERVER calls
 *    the first one when it persists the answer and each CLIENT calls it again
 *    to render the same step optimistically, before any reload — three callers
 *    of one rule, which is the exact shape that drifted in (1) and (2).
 *
 * NOT the §7d treatment, which collapsed an answered step to `Check` +
 * `Setting off · Sat 19 Sep`. That was built and cancelled (item 9,
 * 2026-09-04). This is the third position and the current one (2026-09-08): the
 * question keeps its OPTIONS, the chosen one rendered as chosen, so scrolling
 * back through setup shows the form the driver actually filled in rather than a
 * flat transcript of it.
 */
import type { ChatFormMeta } from '../types/trip';

export type QuestionKind =
  | 'text'
  | 'number'
  | 'integer'
  | 'select'
  | 'chips'
  | 'vehicle'
  | 'handoff';

/**
 * Kinds whose options are ANSWERS: tapping one submits it. `select` is
 * tap-only; `chips` keeps the composer live alongside. Anything not listed
 * here must not render an option row, because nothing would accept the tap.
 */
export const TAP_TO_ANSWER_KINDS = ['select', 'chips'] as const;
export type TapToAnswerKind = (typeof TAP_TO_ANSWER_KINDS)[number];

export function isTapToAnswerKind(kind: QuestionKind): kind is TapToAnswerKind {
  return (TAP_TO_ANSWER_KINDS as readonly string[]).includes(kind);
}

/**
 * Kinds that LOCK the composer: the only way to answer is on the card.
 * `select` because tapping is the whole answer; `vehicle` because the card
 * carries two fields submitted together and no single text box could stand
 * for them. `chips` is deliberately absent — "the second week of June" is a
 * valid start date and no chip can express it.
 */
export const COMPOSER_LOCKED_KINDS = ['select', 'vehicle'] as const;

export function locksComposer(kind: QuestionKind): boolean {
  return (COMPOSER_LOCKED_KINDS as readonly string[]).includes(kind);
}

// ── Answered steps ─────────────────────────────────────────────────────────

/** The question fields `buildFormMeta` needs — a structural subset of `Question`. */
export interface AnsweredQuestionShape {
  label: string;
  kind: QuestionKind;
  options?: { value: string; label: string }[];
}

/**
 * Freeze an answered onboarding step into the row that records it.
 *
 * Called by the server when it writes the `form_answer` row, and by each client
 * when it appends the same answer optimistically — one function so a step
 * rendered before the reload cannot look different from the same step after it.
 *
 * `selected` is resolved by matching the raw submitted value against the option
 * `value`s FIRST and the labels second. Both are needed: a chip tap submits the
 * value, while a `chips` step keeps the composer live, so the driver can also
 * type the exact words of a chip. Anything that matches neither is a typed
 * answer and leaves `selected` null — which is the correct outcome, not a
 * failure: "the second week of June" is a valid start date and no chip
 * expresses it.
 */
export function buildFormMeta(
  question: AnsweredQuestionShape,
  answerLabel: string,
  rawValue?: unknown
): ChatFormMeta {
  const options = (question.options ?? []).map((o) => ({ value: o.value, label: o.label }));
  const raw = typeof rawValue === 'string' || typeof rawValue === 'number' ? String(rawValue) : null;
  const norm = (v: string) => v.trim().toLowerCase();
  const candidates = [raw, answerLabel].filter((v): v is string => !!v && v.trim().length > 0);

  let selected: string | null = null;
  for (const c of candidates) {
    const byValue = options.find((o) => norm(o.value) === norm(c));
    if (byValue) {
      selected = byValue.value;
      break;
    }
    const byLabel = options.find((o) => norm(o.label) === norm(c));
    if (byLabel) {
      selected = byLabel.value;
      break;
    }
  }

  return { question: question.label, kind: question.kind, options, selected, answerLabel };
}

/**
 * Whether a CLIENT should record the answered step itself, or leave it to the
 * server's rows.
 *
 * `vehicle` is the one kind where the two disagree by construction: the card
 * carries a nickname and a range submitted together, so the client holds ONE
 * answer ("Duncan · 500 km") while the server writes TWO steps, one per half.
 * A client-built widget would show the range chips under a pill reading
 * "Duncan · 500 km", and then turn into two different steps on reload. So the
 * client stays out of it and the vehicle answer keeps the plain bubble it has
 * always had.
 */
export function clientRecordsAnsweredStep(kind: QuestionKind): boolean {
  return kind !== 'vehicle';
}

/** The row fields `collapseOnboardingSteps` reads — satisfied by ChatMessage and by
 *  each client's UIMessage, neither of which this module should have to know about. */
export interface CollapsibleRow {
  kind?: string;
  content: string;
  form_meta?: ChatFormMeta | null;
}

/**
 * Fold each answered onboarding step's two rows into one.
 *
 * A step is stored as it happened: a `form_question` row, then a `form_answer`
 * row. Rendered literally that is a question bubble followed by a bare text
 * bubble, and the options are nowhere. This pairs each `form_answer` that
 * carries `form_meta` with the nearest EARLIER, still-unclaimed `form_question`
 * naming the same label, drops that question row, and leaves the answer row
 * standing in its place — so the widget renders exactly where the question was,
 * and chronological order is untouched.
 *
 * Three properties worth stating, because each one is a bug if it goes:
 *  - NEAREST EARLIER, not "any": the clarify path asks `trip_date` twice under
 *    different labels, and a range_help detour returns to a question already
 *    asked. Claiming the first match anywhere would collapse the wrong pair.
 *  - STILL UNCLAIMED: one question row can only answer for one step.
 *  - Rows WITHOUT meta are untouched. Every row written before the column
 *    existed has none, so an old trip keeps rendering as the two plain bubbles
 *    it always did rather than losing its answer.
 */
export function collapseOnboardingSteps<T extends CollapsibleRow>(rows: T[]): T[] {
  const drop = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const meta = rows[i].form_meta;
    if (rows[i].kind !== 'form_answer' || !meta) continue;
    /*
     * A step that offered NOTHING has no widget to redraw — the opening trip
     * description is free text, and rendering it as one enormous pill under
     * its own question is worse than the plain question-then-answer bubbles it
     * replaced. Those steps keep the shape they have always had.
     */
    if (meta.options.length === 0) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (drop.has(j)) continue;
      if (rows[j].kind !== 'form_question') continue;
      if (rows[j].content !== meta.question) continue;
      drop.add(j);
      break;
    }
  }
  return drop.size === 0 ? rows : rows.filter((_, i) => !drop.has(i));
}

/** One chip on an answered step, as it should be drawn. */
export interface AnsweredChip {
  key: string;
  label: string;
  /** The driver's answer. Exactly one chip in the list carries this. */
  selected: boolean;
}

/**
 * The chips an ANSWERED step should draw, decided once for both platforms.
 *
 * The two clients cannot share a renderer — one emits `<button>` with inline
 * styles, the other a `Pressable` with a StyleSheet — so what travels is the
 * DECISION, not the markup. Otherwise "which chip is lit" would be written
 * twice and would eventually disagree, which is the failure `TAP_TO_ANSWER_KINDS`
 * already exists to prevent one row further up.
 *
 * A typed answer that matched no option is appended as its OWN lit chip rather
 * than dropped. That case is not an edge: `chips` steps keep the composer live
 * on purpose, so "Thu 8 Oct" on a step offering Next Saturday / In a month /
 * Not sure yet is the ordinary path, and a step that showed three unlit chips
 * and no answer would be a worse record than the flat bubble it replaced.
 */
export function answeredChips(meta: ChatFormMeta): AnsweredChip[] {
  const chips: AnsweredChip[] = meta.options.map((o) => ({
    key: o.value,
    label: o.label,
    selected: meta.selected != null && o.value === meta.selected,
  }));
  if (meta.selected == null && meta.answerLabel.trim().length > 0) {
    chips.push({ key: `__typed__:${meta.answerLabel}`, label: meta.answerLabel, selected: true });
  }
  return chips;
}

// ── Question labels ────────────────────────────────────────────────────────

export const TRIP_INTENT_LABEL =
  "Where are we going? One city is enough to start — I'll sort the fuel.";

export const TRIP_ORIGIN_LABEL = 'Where are you starting from?';

/** The origin question when the device already knows where the driver is. */
export function tripOriginLabelFor(city: string): string {
  return `Are you leaving from ${city}?`;
}

const TRIP_ORIGIN_LABEL_PREFIX = 'Are you leaving from ';

export const TRIP_DATE_LABEL = 'When are you setting off?';

export const TRIP_DATE_CLARIFY_LABEL =
  "No worries if it's not locked in — roughly what time of year are you thinking? Even \"next summer\" or \"around Christmas\" works, and I'll pencil in a date you can refine later.";

export const TRIP_PACE_LABEL = 'How long do you want to drive each day?';

/** Hours a day the pace step accepts. 8 is the hard cap the planner keeps anyway. */
export const DAILY_DRIVE_HOURS_MIN = 1;
export const DAILY_DRIVE_HOURS_MAX = 8;

/**
 * The pace answer, as a whole number of hours in band — from a chip ("6"), a
 * typed number ("5"), or a phrase with one in it ("about 5 hours", "5h").
 * Null for anything else; the caller re-asks rather than guessing.
 */
export function parseDailyDriveHours(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= DAILY_DRIVE_HOURS_MIN && raw <= DAILY_DRIVE_HOURS_MAX ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const m = raw.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Math.round(Number(m[1].replace(',', '.')));
  return n >= DAILY_DRIVE_HOURS_MIN && n <= DAILY_DRIVE_HOURS_MAX ? n : null;
}

export const UNITS_LABEL =
  'Do you want distances in metric (kilometers) or imperial (miles)?';

/** Penny's line above the composite name+range card (frame 7e). */
export const VEHICLE_SETUP_LABEL = 'Last thing — what are you driving?';

/** The first-message prompt rows (frame 7b). Shapes to edit, never sent verbatim. */
export const TRIP_INTENT_PROMPTS = [
  'Paris to Stuttgart, 5 h days',
  'Pyrenees loop with 3 rest days',
] as const;

/** True for either wording of the origin question. */
export function isTripOriginLabel(label: string): boolean {
  return label === TRIP_ORIGIN_LABEL || label.startsWith(TRIP_ORIGIN_LABEL_PREFIX);
}

export function isTripPaceLabel(label: string): boolean {
  return label === TRIP_PACE_LABEL;
}

/** True for either wording of the date question. */
export function isTripDateLabel(label: string): boolean {
  return label === TRIP_DATE_LABEL || label === TRIP_DATE_CLARIFY_LABEL;
}

/**
 * The greeting can carry a trial line in front of it ("7 days free … Where
 * are we going?"), so the intent question is matched on its tail.
 */
export function isTripIntentLabel(label: string): boolean {
  return label.endsWith(TRIP_INTENT_LABEL);
}

/**
 * The city half of a stored place label. `reverseGeocode` keeps the last two
 * comma parts ("Girona, Spain"); the question and the composer placeholder
 * want just the town. A label with no comma is returned whole.
 */
export function cityFromPlace(place: string | null | undefined): string | null {
  if (!place) return null;
  const first = place.split(',')[0]?.trim() ?? '';
  return first.length > 0 ? first.slice(0, 60) : null;
}

/**
 * The location-seeded composer placeholder for the first message (frame 7b):
 * `Girona to …` when the device city is known, `Where to?` otherwise.
 */
export function intentPlaceholder(city: string | null): { city: string | null; rest: string } {
  return city ? { city, rest: ' to …' } : { city: null, rest: 'Where to?' };
}
