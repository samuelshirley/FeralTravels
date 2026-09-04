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
 * Deliberately NOT here: receipt titles. The §7d treatment that collapsed an
 * answered step to `Check` + `Setting off · Sat 19 Sep` was built and then
 * cancelled (item 9, 2026-09-04): after the first question, onboarding is
 * ordinary chat — each question a Penny bubble, each answer a user bubble,
 * left in the transcript.
 */

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
