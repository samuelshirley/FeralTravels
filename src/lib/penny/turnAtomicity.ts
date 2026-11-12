/**
 * A Penny turn is all-or-nothing for the trip — pure, no DB.
 *
 * WHY (incident 2026-11-10, trip 65972b73): "go up the Portuguese coast".
 * Penny queued 11 delete_leg + 11 add_leg. The contiguity gate blocked the
 * deletes and the adds dispatched anyway, because each gate rejected ITS OWN
 * action type and let the rest of the batch through. Continuity repair then
 * re-chained the old legs that should have been deleted onto their new
 * neighbours: Tarifa→Tarifa 0 km, Trigueros→Trigueros 0 km, Lagos→Lagos 3 km,
 * Girona→Écija 1,007 km — a 22-day plan under a reply saying "exactly 10 days".
 *
 * A batch is ONE edit. Its actions only make sense together (the adds replace
 * the deletes; the update closes the hole the delete leaves), so applying part
 * of it is never the conservative choice — it builds a route nobody asked for.
 * The feasibility gate had the same hole from the other side: it rejected the
 * add_legs of an over-budget plan and let that plan's delete_legs through,
 * which guts the trip.
 *
 * THE RULE: every pre-dispatch gate is asked first; if ANY of them rejects
 * ANY action, NOTHING in the batch dispatches and the trip is untouched. The
 * route then reports every queued action as not saved, and appends a
 * server-authored correction to Penny's already-streamed prose.
 *
 * An action that passes every gate and then THROWS during dispatch is the
 * other half: the route dispatches inside ONE database transaction
 * (src/server/db/turnScope.ts), rolls the whole batch back, and reports it
 * with `rejectionFromDispatchFailure` — same rows, same correction line.
 */
import type { ValidatedAction } from './tools';

export type TurnRejection = {
  /** One sentence, user-facing: why the edit was not saved. */
  reason: string;
  /** One row per queued action, in batch order — what the banner lists. */
  rows: Array<{ action: string; error: string }>;
  /** The delete_leg ids the contiguity gate named (for ops logging). */
  blockedDeleteLegIds: string[];
};

export const CONTIGUITY_REASON =
  'deleting a day would leave a hole in the route that nothing in the same edit fills';

/**
 * Decide, before anything is written, whether the batch may dispatch at all.
 * Returns null when it may; otherwise the rejection, covering EVERY queued
 * action. `submit_idea` is a side-effect log, never a trip mutation — it is
 * held back with the rest (nothing dispatches) but listed in no banner.
 */
export function rejectTurnBeforeDispatch(input: {
  actions: ReadonlyArray<ValidatedAction>;
  /** From findGapCreatingDeletes. */
  blockedDeleteLegIds: ReadonlySet<string>;
  /** extract_trip_intent ran and the feasibility verdict was missing or over budget. */
  feasibilityBlocks: boolean;
  feasibilityVerdict: string | null;
}): TurnRejection | null {
  const hasAddLeg = input.actions.some((a) => a.name === 'add_leg');
  const feasibility = input.feasibilityBlocks && hasAddLeg;
  const blockedDeletes = input.actions.filter(
    (a): a is ValidatedAction & { name: 'delete_leg' } =>
      a.name === 'delete_leg' && input.blockedDeleteLegIds.has(a.input.leg_id),
  );
  if (!feasibility && blockedDeletes.length === 0) return null;

  const reason = feasibility
    ? input.feasibilityVerdict === 'over_budget'
      ? 'the plan exceeds your time budget'
      : 'the plan was not checked against your time budget'
    : CONTIGUITY_REASON;

  const rows = input.actions
    .filter((a) => a.name !== 'submit_idea')
    .map((a) => ({
      action: a.name,
      error:
        a.name === 'delete_leg' && input.blockedDeleteLegIds.has(a.input.leg_id)
          ? 'Blocked: deleting this leg would break route continuity. Nothing from this edit was saved.'
          : feasibility && a.name === 'add_leg'
            ? `Plan rejected — ${reason}. Nothing from this edit was saved.`
            : `Not applied: ${reason}, so nothing from this edit was saved.`,
    }));

  return {
    reason,
    rows,
    blockedDeleteLegIds: blockedDeletes.map((a) => a.input.leg_id),
  };
}

/**
 * The batch passed every gate, then action `failedIndex` threw inside the turn
 * transaction, so the whole batch was rolled back. Same shape and wording as a
 * gate rejection, so the route reports both the same way.
 */
export function rejectionFromDispatchFailure(
  actions: ReadonlyArray<ValidatedAction>,
  failedIndex: number,
  message: string,
): TurnRejection {
  const failed = actions[failedIndex];
  const reason = `saving ${failed?.name ?? 'a change'} failed (${message})`;
  return {
    reason,
    rows: actions.flatMap((a, i) =>
      a.name === 'submit_idea'
        ? []
        : [
            {
              action: a.name,
              error:
                i === failedIndex
                  ? `${message} Nothing from this edit was saved.`
                  : `Not applied: ${reason}, so nothing from this edit was saved.`,
            },
          ],
    ),
    blockedDeleteLegIds: [],
  };
}
