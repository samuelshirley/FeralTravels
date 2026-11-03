import 'server-only';

import { countMapsLinksInMessage } from '@/lib/coordsResolve';
import { parseDayReference } from '@/lib/dayReference';
import { countToolNames, turnRouteTruth, type TurnFacts } from '@/lib/jevRoute';
import { TOOLS, type ValidatedAction } from '@/lib/penny/tools';
import { findJevCompareForTurn, recordJevTurnTruth, type JevTurnTruthMeta } from '@/server/repos/jev';
import { getStopTypes } from '@/server/repos/stops';
import { getTripDayFrame } from '@/server/repos/trips';
import type { StopType } from '@/types/trip';

/**
 * The ground-truth half of the Jev route measurement: after a Penny turn,
 * write down what she actually did with the message, on the message's compare
 * row (`repos/jev.ts`). MEASUREMENT ONLY — nothing here changes a turn.
 *
 * Two calls, because one fact has to be read before the turn's actions are
 * dispatched: whether a `delete_stop`'s target was a fuel stop is unknowable
 * once the row is gone. So:
 *
 *   prepareJevTurnTruth  — before dispatch: is there a compare row for this
 *                          turn at all (one indexed read; if not, nothing
 *                          else runs), the targeted stops' types, and the
 *                          trip's days as they were.
 *   finishJevTurnTruth   — after the turn is marked done: build the facts,
 *                          grade them (`turnRouteTruth`), record them.
 *   recordJevTurnError   — the turn failed: say so, so it is left out of the
 *                          grading rather than counted as "still pending".
 *
 * Every function here NEVER THROWS. The measurement must not cost a driver
 * their turn, and every failure is logged.
 *
 * Privacy: what is recorded is tool NAMES (only the registry's own — anything
 * else becomes `unknown_tool`), counts, booleans and day numbers. The message
 * is read here to count its Maps links and parse a day reference, and neither
 * the message nor any part of it is written anywhere.
 */

const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

export interface JevTurnTruthPrep {
  eventId: number;
  stopTypes: Map<string, StopType>;
  /** Leg ids in day order, as the trip was when Penny's actions were validated. */
  legIds: string[];
  startISO: string | null;
  todayISO: string;
}

function stopTargets(actions: readonly ValidatedAction[]): string[] {
  const ids: string[] = [];
  for (const a of actions) {
    if (a.name === 'update_stop' || a.name === 'delete_stop') ids.push(a.input.stop_id);
  }
  return ids;
}

export async function prepareJevTurnTruth(
  tripId: string,
  turnId: string,
  validatedActions: readonly ValidatedAction[]
): Promise<JevTurnTruthPrep | null> {
  try {
    const eventId = await findJevCompareForTurn(tripId, turnId);
    if (eventId === null) return null;
    const [stopTypes, frame] = await Promise.all([
      getStopTypes(stopTargets(validatedActions)),
      getTripDayFrame(tripId),
    ]);
    return {
      eventId,
      stopTypes,
      legIds: frame?.legIds ?? [],
      startISO: frame?.startISO ?? null,
      todayISO: frame?.todayISO ?? new Date().toISOString().slice(0, 10),
    };
  } catch (err) {
    console.error('[jevTurnTruth] could not prepare the turn truth', err);
    return null;
  }
}

/** The facts `turnRouteTruth` grades, from a finished turn. Pure. */
export function buildTurnFacts(input: {
  message: string;
  toolTrace: readonly (readonly string[])[];
  fuelPlanRan: boolean;
  validatedActions: readonly ValidatedAction[];
  appliedActions: readonly ValidatedAction[];
  failedCount: number;
  stopTypes: ReadonlyMap<string, StopType>;
}): TurnFacts {
  let fuelStopUpdates = 0;
  let fuelStopDeletes = 0;
  let otherStopEdits = 0;
  for (const a of input.validatedActions) {
    if (a.name !== 'update_stop' && a.name !== 'delete_stop') continue;
    // A stop we could not find is not a fuel stop we know of: count it as other.
    const isFuel = input.stopTypes.get(a.input.stop_id) === 'fuel';
    if (!isFuel) otherStopEdits += 1;
    else if (a.name === 'update_stop') fuelStopUpdates += 1;
    else fuelStopDeletes += 1;
  }
  return {
    status: 'done',
    toolCounts: countToolNames(input.toolTrace),
    appliedCounts: countToolNames([input.appliedActions.map((a) => a.name)]),
    failedCount: input.failedCount,
    fuelPlanRan: input.fuelPlanRan,
    fuelStopUpdates,
    fuelStopDeletes,
    otherStopEdits,
    mapsLinkCount: countMapsLinksInMessage(input.message),
  };
}

export async function finishJevTurnTruth(
  prep: JevTurnTruthPrep | null,
  input: {
    message: string;
    toolTrace: readonly (readonly string[])[];
    fuelPlanRan: boolean;
    validatedActions: readonly ValidatedAction[];
    appliedActions: readonly ValidatedAction[];
    failedCount: number;
    usageEventId: number | null;
  }
): Promise<void> {
  if (!prep) return;
  try {
    const facts = buildTurnFacts({ ...input, stopTypes: prep.stopTypes });
    const truth = turnRouteTruth(facts);

    // Case 2's day: only where a stop was actually added, so the free parse
    // is graded against the day Penny chose.
    const addedDays = input.appliedActions
      .flatMap((a) => (a.name === 'add_stop' ? [prep.legIds.indexOf(a.input.leg_id) + 1] : []))
      .filter((d) => d >= 1);
    let dayParseKind: string | null = null;
    let parsedDay: number | null = null;
    let dayMatch: boolean | null = null;
    if (facts.appliedCounts.add_stop) {
      const ref = parseDayReference(input.message, {
        dayCount: prep.legIds.length,
        tripStartISO: prep.startISO,
        todayISO: prep.todayISO,
      });
      dayParseKind = ref.kind;
      parsedDay = 'day' in ref ? ref.day : null;
      dayMatch = parsedDay !== null && addedDays.length > 0 ? addedDays.includes(parsedDay) : null;
    }

    const meta: JevTurnTruthMeta = {
      turnStatus: 'done',
      truth,
      toolCounts: facts.toolCounts,
      appliedCounts: facts.appliedCounts,
      failedCount: facts.failedCount,
      fuelPlanRan: facts.fuelPlanRan,
      fuelStopUpdates: facts.fuelStopUpdates,
      fuelStopDeletes: facts.fuelStopDeletes,
      otherStopEdits: facts.otherStopEdits,
      mapsLinkCount: facts.mapsLinkCount,
      dayParseKind,
      parsedDay,
      addedDays,
      dayMatch,
      pennyUsageEventId: input.usageEventId,
    };
    await recordJevTurnTruth(prep.eventId, meta, KNOWN_TOOLS);
  } catch (err) {
    console.error('[jevTurnTruth] could not record the turn truth', err);
  }
}

/** The turn failed: recorded so it is excluded from grading, not left "pending". */
export async function recordJevTurnError(tripId: string, turnId: string): Promise<void> {
  try {
    const eventId = await findJevCompareForTurn(tripId, turnId);
    if (eventId === null) return;
    await recordJevTurnTruth(
      eventId,
      {
        turnStatus: 'error',
        truth: null,
        toolCounts: {},
        appliedCounts: {},
        failedCount: 0,
        fuelPlanRan: false,
        fuelStopUpdates: 0,
        fuelStopDeletes: 0,
        otherStopEdits: 0,
        mapsLinkCount: 0,
        dayParseKind: null,
        parsedDay: null,
        addedDays: [],
        dayMatch: null,
        pennyUsageEventId: null,
      },
      KNOWN_TOOLS
    );
  } catch (err) {
    console.error('[jevTurnTruth] could not record the failed turn', err);
  }
}
