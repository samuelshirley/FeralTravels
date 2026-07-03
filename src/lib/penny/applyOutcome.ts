/**
 * Pure derivation of the user-facing save outcome from a replan `applied`
 * payload — shared by the live SSE stream path AND the reconcile/heal path
 * (where the same payload is read back off the durable `penny_turns` record).
 *
 * Keeping this pure means the "did the save work / partially work / silently
 * do nothing" decision is identical whether the client saw the turn live or
 * healed it on reopen — and it's unit-testable without a React/stream harness.
 *
 * Field semantics (mirrors the server `applied` event):
 * - `persistFailed*` are DB/feasibility outcomes — authoritative for banners.
 * - `failed*` are the merged total (validation + persist) for ops/logging.
 * - Legacy payloads omitted `persistFailed*`; we fall back to `failed*` then.
 */
export interface ApplyOutcomeInput {
  appliedCount: number;
  failedCount: number;
  failedActions?: Array<{ action: string; error: string }>;
  persistFailedCount?: number;
  persistFailedActions?: Array<{ action: string; error: string }>;
  validationFailures?: Array<{ action: string; error: string }>;
  validatedQueuedCount?: number;
  changes?: { changes?: unknown[] } | null;
  /**
   * update_leg edits the deterministic pipeline (schedule rebuild / continuity
   * repair) rewrote AFTER they were applied — Penny's already-streamed prose
   * describes them, but the persisted plan differs. Absent on legacy payloads.
   * See lib/penny/editOverride.ts.
   */
  overriddenEdits?: Array<{ legId: string; legTitle: string | null; fields: string[] }>;
}

export interface ApplyOutcome {
  /** Hard failure copy for the bubble (nothing — or the wrong thing — saved). */
  applyError: string | null;
  /** Soft warning copy when some writes landed and some didn't. */
  partialApplyWarning: string | null;
  /** Validation-only failures, surfaced for debug logging (not user-facing). */
  validationFailures: Array<{ action: string; error: string }>;
  /** Whether the trip data changed (caller reloads the trip when true). */
  appliedChanges: boolean;
}

/**
 * Count the validated actions that represent TRIP MUTATIONS — the number the
 * server reports as `validatedQueuedCount` (and which `deriveApplyOutcome`
 * treats as "Penny proposed changes").
 *
 * `submit_idea` is a side-effect log (usage_events), not a trip mutation. The
 * dispatch loop already excludes it from `appliedCount` so it doesn't fire the
 * green "Changes applied" banner; it MUST be excluded here for the same reason,
 * or a submit_idea-only turn counts as "proposed 1 / applied 0" and renders the
 * false red "Penny proposed changes but nothing was saved" banner even though
 * the idea logged successfully (the "find me a fuel stop within 250km" bug).
 *
 * Structurally typed ({ name: string }) so this client-shared module doesn't
 * import the server-only ValidatedAction union.
 */
export function countQueuedMutations(
  actions: ReadonlyArray<{ name: string }>
): number {
  return actions.filter((a) => a.name !== 'submit_idea').length;
}

export function deriveApplyOutcome(ev: ApplyOutcomeInput): ApplyOutcome {
  const persistFieldsPresent =
    typeof ev.persistFailedCount === 'number' || Array.isArray(ev.persistFailedActions);

  const failedActions = Array.isArray(ev.failedActions) ? ev.failedActions : [];

  const persistFailedActions = persistFieldsPresent
    ? Array.isArray(ev.persistFailedActions)
      ? ev.persistFailedActions
      : []
    : failedActions;

  const persistFailedCount = persistFieldsPresent
    ? typeof ev.persistFailedCount === 'number'
      ? ev.persistFailedCount
      : persistFailedActions.length
    : ev.failedCount;

  const changeLen = Array.isArray(ev.changes?.changes) ? ev.changes!.changes!.length : 0;
  const hadProposedChanges =
    changeLen > 0 ||
    (typeof ev.validatedQueuedCount === 'number' && ev.validatedQueuedCount > 0);

  let applyError: string | null = null;
  let partialApplyWarning: string | null = null;

  if (persistFailedCount > 0 && ev.appliedCount > 0) {
    partialApplyWarning = `Some edits didn't save: ${persistFailedActions
      .map((f) => f.action)
      .join(', ')}`;
  } else if (persistFailedCount > 0) {
    const details = persistFailedActions.map((f) => `${f.action}: ${f.error}`).join('; ');
    applyError = `Changes failed to save — ${details}`;
  } else if (hadProposedChanges && ev.appliedCount === 0) {
    applyError =
      'Penny proposed changes but nothing was saved. Re-ask her with more detail (e.g. starting point, destination).';
  }

  // Pipeline-overridden edits: the writes LANDED (so this is never a hard
  // failure) but the schedule rebuild / continuity repair then rewrote what
  // Penny wrote, so her description may no longer match the plan. Surface as a
  // soft warning on the same channel as partial saves — appended when one is
  // already present.
  const overridden = Array.isArray(ev.overriddenEdits) ? ev.overriddenEdits : [];
  if (overridden.length > 0) {
    const names = overridden.map((o) => `"${o.legTitle ?? o.legId}"`).join(', ');
    const overrideMsg = `The schedule adjusted ${
      overridden.length === 1 ? 'one of these edits' : `${overridden.length} of these edits`
    } after saving (${names}) — check the itinerary, it may differ from the description above.`;
    partialApplyWarning = partialApplyWarning
      ? `${partialApplyWarning} ${overrideMsg}`
      : overrideMsg;
  }

  return {
    applyError,
    partialApplyWarning,
    validationFailures: Array.isArray(ev.validationFailures) ? ev.validationFailures : [],
    appliedChanges: ev.appliedCount > 0,
  };
}
