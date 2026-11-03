/**
 * Jev's ROUTE question, and how we grade its answer — MEASUREMENT ONLY.
 *
 * In compare mode the gate asks Jev a second Choice question in the same
 * `/v1/systemone` request as the tier: which of four things would handle this
 * message? Nothing acts on the answer. It is logged beside what Penny then
 * actually did with the message, so /admin can say — from real traffic —
 * whether a free code path could have handled it instead of a ~$0.085 Penny
 * turn, and how many dollars that would have been.
 *
 * Pure: no I/O, no model. The gate builds the question from `JEV_ROUTE_*`
 * (`src/server/jev/question.ts`), the replan route feeds `turnRouteTruth` the
 * facts of the turn that followed, and `repos/jev.ts` sums the result.
 *
 * Privacy: every input here is a NAME of a tool, a count, a boolean or a day
 * number. Nothing a driver wrote is ever an input or an output.
 */

export const JEV_ROUTES = ['add_pasted_place', 'replace_fuel_stop', 'off_topic', 'needs_penny'] as const;
export type JevRoute = (typeof JEV_ROUTES)[number];

/** The routes a code path could take over from Penny — the ones whose turns cost money. */
export const PENNY_SAVING_ROUTES = ['add_pasted_place', 'replace_fuel_stop'] as const satisfies readonly JevRoute[];

/**
 * The question as Jev sees it. Short on purpose — every token here is sent
 * with every compared message — and plain: each criterion says what a message
 * in that bucket asks for, not what we would do with it.
 */
export const JEV_ROUTE_INSTRUCTIONS = 'Which one of these does the message ask for?';

export const JEV_ROUTE_CRITERIA: Record<JevRoute, string> = {
  add_pasted_place: 'Only to add the place in a pasted map link to the trip, maybe on a named day.',
  replace_fuel_stop: 'Only to swap a fuel or gas stop for a different station.',
  off_topic: 'Nothing a road-trip planner can do.',
  needs_penny: 'Anything else, or more than one thing.',
};

export function isJevRoute(v: unknown): v is JevRoute {
  return typeof v === 'string' && (JEV_ROUTES as readonly string[]).includes(v);
}

// ── Ground truth ─────────────────────────────────────────────────────────────

/**
 * What a Penny turn did, as names and counts. Recorded once the turn ends,
 * on the compare row of the message that started it.
 */
export interface TurnFacts {
  /** `done` = Penny finished and her actions were dispatched; `error` = the turn failed. */
  status: 'done' | 'error';
  /** Every tool Penny called this turn, lookups and writes, with how often. */
  toolCounts: Record<string, number>;
  /** Write actions that PERSISTED (dispatched without error), by name. */
  appliedCounts: Record<string, number>;
  /** Validation failures plus persist failures. Any failure means Penny's turn was not clean. */
  failedCount: number;
  /** `plan_fuel_stops` actually ran Finn on a leg this turn. */
  fuelPlanRan: boolean;
  /** Validated `update_stop` actions whose target was a fuel stop. */
  fuelStopUpdates: number;
  /** Validated `delete_stop` actions whose target was a fuel stop. */
  fuelStopDeletes: number;
  /** Validated `update_stop`/`delete_stop` actions on anything that was NOT a fuel stop. */
  otherStopEdits: number;
  /** Google/Apple Maps links in the message, by the same detector Penny's turn uses. */
  mapsLinkCount: number;
}

/** Reads Penny may make without changing anything — code would make its own. */
const READ_TOOLS = ['resolve_place', 'get_route'] as const;

const ADD_PLACE_TOOLS = new Set<string>([...READ_TOOLS, 'add_stop']);
const FUEL_TOOLS = new Set<string>([...READ_TOOLS, 'plan_fuel_stops', 'update_stop', 'delete_stop']);

function onlyUses(counts: Record<string, number>, allowed: Set<string>): boolean {
  return Object.entries(counts).every(([name, n]) => n <= 0 || allowed.has(name));
}

function count(counts: Record<string, number>, name: string): number {
  return counts[name] ?? 0;
}

/**
 * Which route a FINISHED Penny turn shows the message needed. The definition
 * of "Jev's route was right", per route:
 *
 *  - `add_pasted_place` — the message carried ≥ 1 Maps link, and the turn was
 *    clean (no failures) and ONLY resolved/added that place: every tool it
 *    called is `resolve_place`, `get_route` or `add_stop`; it persisted
 *    between 1 and (number of links) `add_stop`s; and it persisted nothing
 *    else. A code path that resolves the link and adds an `other` stop to the
 *    named day reproduces that turn's whole effect.
 *
 *  - `replace_fuel_stop` — the turn was clean and ONLY touched fuel stops:
 *    every tool is `plan_fuel_stops`, `update_stop`, `delete_stop` or a read;
 *    it either re-ran Finn (`fuelPlanRan`) or updated at least one fuel stop;
 *    no stop edit landed on a non-fuel stop; and nothing but `update_stop` /
 *    `delete_stop` persisted. Deleting a fuel stop with no replacement is NOT
 *    a replacement. A code path that re-runs Finn reproduces that effect.
 *
 *  - `needs_penny` — any other finished turn: planning, several changes, a
 *    question answered in prose, a reply with no tool at all, anything that
 *    failed part-way. Penny was needed.
 *
 *  - `off_topic` is never a TURN's truth: an off-topic message never reaches
 *    Penny. Its truth is Haiku's tier — see `compareRowTruth`.
 *
 * A turn that ERRORED returns null: what it would have done is unknown, so it
 * is left out of every precision and coverage count rather than guessed.
 */
export function turnRouteTruth(f: TurnFacts): Exclude<JevRoute, 'off_topic'> | null {
  if (f.status !== 'done') return null;
  if (f.failedCount > 0) return 'needs_penny';

  const added = count(f.appliedCounts, 'add_stop');
  const appliedOther = Object.entries(f.appliedCounts).some(([name, n]) => n > 0 && name !== 'add_stop');
  if (
    f.mapsLinkCount >= 1 &&
    onlyUses(f.toolCounts, ADD_PLACE_TOOLS) &&
    added >= 1 &&
    added <= f.mapsLinkCount &&
    !appliedOther
  ) {
    return 'add_pasted_place';
  }

  const appliedNonEdit = Object.entries(f.appliedCounts).some(
    ([name, n]) => n > 0 && name !== 'update_stop' && name !== 'delete_stop'
  );
  if (
    onlyUses(f.toolCounts, FUEL_TOOLS) &&
    (f.fuelPlanRan || f.fuelStopUpdates >= 1) &&
    f.otherStopEdits === 0 &&
    !appliedNonEdit
  ) {
    return 'replace_fuel_stop';
  }

  return 'needs_penny';
}

/**
 * The truth for one compare row. Haiku's refusal (T2/T3, on the classifier
 * path) is the only evidence we have that a message was off-topic, and the
 * row's own record of it; a T1 message's truth is what its turn did, or null
 * until (or unless) a finished turn is recorded.
 */
export function compareRowTruth(row: {
  tierAsked: boolean;
  haikuTier: 'T1' | 'T2' | 'T3' | null;
  turnTruth: Exclude<JevRoute, 'off_topic'> | null;
}): JevRoute | null {
  if (row.tierAsked && (row.haikuTier === 'T2' || row.haikuTier === 'T3')) return 'off_topic';
  return row.turnTruth;
}

/** Tool names → counts, from the per-model-call trace Penny's turn already keeps. */
export function countToolNames(trace: readonly (readonly string[])[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const call of trace) for (const name of call) out[name] = (out[name] ?? 0) + 1;
  return out;
}
