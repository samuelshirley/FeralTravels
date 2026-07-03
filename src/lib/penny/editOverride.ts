/**
 * Post-pipeline edit-override detection — pure, no DB.
 *
 * Penny's prose streams BEFORE her actions are applied, and the deterministic
 * pipeline (rebuildTripSchedule + repairLegContinuity) runs AFTER they land and
 * may rewrite what she just wrote: the schedule re-materializes rest days at
 * the previous drive's end, and continuity repair re-chains starts and
 * re-routes. When that happens, the transcript claims an edit ("Saved —
 * tomorrow's drive heads to the campsite near Alset") that the persisted plan
 * no longer contains — the worst kind of silent divergence, because the user
 * trusts the words over the map.
 *
 * This module compares the location-identity fields of each applied update_leg
 * against the persisted rows AFTER the pipeline settles. Any mismatch means the
 * pipeline overrode the edit; the caller logs it (`penny:edit-overridden`) and
 * surfaces a warning on the bubble so the words can't quietly outrun the plan.
 *
 * Deliberately limited to update_leg and to WHERE fields (title, names,
 * coords): metrics (distance/time) are legitimately recomputed by re-routing,
 * and add_leg ids aren't knowable here (assigned at dispatch).
 */

export interface OverrideCheckLegRow {
  id: string;
  title: string | null;
  startName: string | null;
  endName: string | null;
  startLat: number | null;
  startLng: number | null;
  endLat: number | null;
  endLng: number | null;
}

/** The slice of an update_leg action this module needs (structural, so the server-only tools union isn't imported). */
export interface OverrideCheckAction {
  name: string;
  input?: {
    leg_id?: string;
    data?: Record<string, unknown>;
  };
}

export interface OverriddenEdit {
  legId: string;
  /** The persisted (post-pipeline) title — what the plan actually says now. */
  legTitle: string | null;
  /** The fields Penny set that no longer match the persisted row. */
  fields: string[];
}

/** ~11 m — well under any real relocation, well over float noise. */
const COORD_EPSILON = 1e-4;

function fieldMatches(patchValue: unknown, rowValue: unknown, isCoord: boolean): boolean {
  if (patchValue == null && rowValue == null) return true;
  if (patchValue == null || rowValue == null) return false;
  if (isCoord && typeof patchValue === 'number' && typeof rowValue === 'number') {
    return Math.abs(patchValue - rowValue) <= COORD_EPSILON;
  }
  return patchValue === rowValue;
}

/** patch key → [row key, isCoord] */
const CHECKED_FIELDS: ReadonlyArray<[string, keyof OverrideCheckLegRow, boolean]> = [
  ['title', 'title', false],
  ['start_name', 'startName', false],
  ['end_name', 'endName', false],
  ['start_lat', 'startLat', true],
  ['start_lng', 'startLng', true],
  ['end_lat', 'endLat', true],
  ['end_lng', 'endLng', true],
];

/**
 * Which applied update_leg edits did the pipeline override?
 *
 * `rows` are the persisted legs AFTER rebuild + repair. An action whose leg id
 * isn't in `rows` is skipped (deleted since, or the id was remapped at
 * dispatch — nothing sound to compare against).
 */
export function detectOverriddenLegEdits(
  actions: ReadonlyArray<OverrideCheckAction>,
  rows: ReadonlyArray<OverrideCheckLegRow>
): OverriddenEdit[] {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const out: OverriddenEdit[] = [];

  for (const action of actions) {
    if (action.name !== 'update_leg') continue;
    const legId = action.input?.leg_id;
    const data = action.input?.data;
    if (!legId || !data) continue;
    const row = rowById.get(legId);
    if (!row) continue;

    const mismatched: string[] = [];
    for (const [patchKey, rowKey, isCoord] of CHECKED_FIELDS) {
      if (data[patchKey] === undefined) continue; // field not part of the edit
      if (!fieldMatches(data[patchKey], row[rowKey], isCoord)) mismatched.push(patchKey);
    }
    if (mismatched.length > 0) {
      out.push({ legId, legTitle: row.title, fields: mismatched });
    }
  }
  return out;
}

/** One-line, user-readable summary for the bubble warning + the usage_events row. */
export function overriddenEditsSummary(edits: ReadonlyArray<OverriddenEdit>): string {
  const parts = edits.map(
    (e) => `"${e.legTitle ?? e.legId}" (${e.fields.join(', ')})`
  );
  return `The schedule adjusted ${edits.length === 1 ? 'an edit' : `${edits.length} edits`} after saving — the plan may differ from the description above: ${parts.join('; ')}`;
}
