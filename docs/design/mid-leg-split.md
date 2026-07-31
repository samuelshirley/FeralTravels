# Mid-leg split — preserve the driven day when the driver stops early

**Status:** design only (2026-07-03). Not built. Scope-flagged: touches `report_position` semantics, which is core MVP behavior — but it serves the existing value thesis (the plan adapts on-trip), it adds no new product surface.

## The incident (prod trip `5f65552b`, 2026-07-03)

One-leg trip: `Trondheim → Hattfjelldal` (398 km), created 2026-07-02. Driver stopped early near Trofors (soaked air filter) and told Penny: *"i had to stop early … 5 or so hours tomorrow toward tromso."* The turn applied:

1. `report_position` — anchor at 65.526, 13.391, `next_leg_id` = the one existing leg.
2. `update_leg` on that same leg — new destination Saltdal.

`applyTripProgress` re-pointed the leg's start to the anchor; `update_leg` re-pointed its end. The single row now reads `Current location (Trofors area) → Saltdal` — the driven day (Trondheim → Trofors) exists **nowhere**. Nothing was deleted; the only leg was overwritten in place. The "behind you" fold had nothing to show because it folds legs *before* `current_leg_id`, and there were none.

## Root cause

The data model has no representation of a **partially driven leg**. `report_position` re-points the *upcoming* leg to start at the driver's position — correct when that leg hasn't been driven yet (they're at the previous leg's end), destructive when it's the leg they were mid-way through. The driven prefix is silently discarded.

## Desired behavior

When the driver reports a position **mid-way along the leg being re-pointed**, split it:

- **Freeze the driven prefix** as its own drive leg (`Trondheim → Trofors area`), inserted immediately before, with the driven distance/time/geometry. It lands behind the anchor → collapses into "behind you" with yesterday's date. History preserved.
- **Re-point the remainder** exactly as today (same leg row keeps its id, stops, routes, constraints — everything downstream that references the leg id keeps working; a same-turn `update_leg` to a new destination edits only the remainder).

Replaying the incident with the fix: leg 0 (frozen) `Trondheim → near Trofors`, ~208 km, dated Jul 3, folded as an earlier day; leg 1 (current) `Trofors area → Saltdal`, dated Jul 4. Exactly what Sam expected to see.

## Trigger rules (deterministic, inside `applyTripProgress`)

Split only when ALL hold for the resolved `nextLegId` leg L:

1. L is a drive leg with non-null start/end coords (same guard as today's re-point).
2. The reported position projects onto L at `drivenKm ≥ MIN_SPLIT_KM` **and** leaves `remainingKm ≥ MIN_SPLIT_KM` (proposal: `MIN_SPLIT_KM = 15`; one named constant). Near the start = GPS noise / hasn't left yet → plain re-point (today's behavior). Near the end = effectively completed → plain re-point; the stub remainder is what today produces and is fine.
3. The position is actually *near* L's route: `perpKm ≤ MAX_OFF_ROUTE_KM` (proposal: 30). A driver far off-route (changed plans entirely, e.g. drove a different road) isn't "mid-leg" — plain re-point, which records the jump honestly, as today.

`drivenKm`/`perpKm` come from projecting the anchor onto L's stored `geometry` — reuse `projectPointOntoRoute` (`src/lib/finn/route.ts`, already pure and exported). Geometry null → fall back to haversine(start, position) for `drivenKm`, skip rule 3.

**Repeat-report merge (no stub-day pileup).** A second report later the same day must not mint a second frozen fragment (each leg = one calendar day, so fragments inflate the day count). Rule: if the leg immediately before L is a fragment of L (`split_parent_leg_id = L.id`, see schema), **extend** it — move its end to the new position, add the incremental distance — instead of inserting. N same-leg reports ⇒ exactly one frozen fragment.

**Not triggered by device GPS.** `updateTripPosition` (the on-load `POST /api/trips/[id]/position`) stays a passive mirror. Splitting happens only on the explicit `report_position` action — a deliberate "this is where I stopped".

## Schema

Migration 0021: `legs.split_parent_leg_id` — nullable uuid, no FK cascade needed (informational; parent deletion leaves it dangling-but-harmless, same stance as other soft references). Purposes: (a) the repeat-report merge above, (b) lets the UI label the fragment ("partial day") later if wanted. No other columns; dates stay rank-derived.

## The frozen fragment row

- `leg_type='drive'`, `sort_order` = L's (L and everything after shift +1; `rebuildTripSchedule` renumbers afterwards anyway).
- `start_*` = L's original start; `end_lat/lng` = the reported position; `end_name` = `place_name` ?? `"Stopped en route"`; `title` = `"{start} → {end_name}"`.
- `distance_km` = `drivenKm`; `drive_time_minutes` = proportional share of L's original time (drivenKm/totalKm), or null when geometry was missing; `geometry` = the polyline prefix up to the projection point (split at `segmentIndex`).
- `fuel_status='none'`, no stops copied. It's behind the fold, and past-day suppression already prevents fuel sourcing on open.
- `split_parent_leg_id` = L.id, `status` = L's status, notes empty.

No routing call for the fragment — everything derives from L's existing geometry. The remainder re-routes exactly as today (`rerouteLeg`).

## Why the surrounding machinery already cooperates (verified against code)

- **Dating / behind fold:** `getTripFull` computes `effectiveStartISO = anchor − rank(current_leg)`. Inserting the fragment bumps the current leg's rank by 1, so the fragment lands on anchor−1 (yesterday when resuming tomorrow) automatically. `behindCutoffRank` folds it (reported floor = current leg's new rank).
- **`repairLegContinuity`:** starts its fix chain at the anchor index and leaves behind-you legs alone. The fragment is contiguous by construction (prev leg's end → original start; fragment end = position = remainder start), so nothing to repair even if scanned.
- **`checkLegContiguity`:** anchor-aware since 2026-07-03; the fragment sits behind the anchor pair — no spurious gap logging.
- **`rebuildTripSchedule`:** one more drive leg = one more "stop" = one more day, which is exactly what re-anchoring implies. Rest-leg assignment (`nearestDriveStopIndex`) is unaffected for legs elsewhere.
- **Fuel:** the remainder's cache is already invalidated on re-point (`invalidateLegFuelCache`); the fragment never sources.
- **`editOverride` tripwire:** a same-turn `update_leg` writes to the remainder, whose persisted start is the anchor — matching what Penny streamed. No false positives expected; add a test.

## Edge cases and accepted limitations

- **Resuming the same day:** the one-leg-per-day model dates the fragment anchor−1 even when the driver stopped and resumes today (fragment actually driven "today"). The fold shows it as an earlier day regardless. Accepted — representing two legs on one calendar day is a bigger model change than this fix warrants.
- **Stops on the driven portion:** user `other` stops stay on the remainder leg even if geographically behind the driver. Accepted for now (user can delete); moving them to the fragment by `alongKm` is a clean follow-up.
- **Tank math (`fuelTankState.ts`):** total km is conserved by the split, but a *visited* fuel stop that stays on the remainder row could be counted on the wrong side of the split. Impact is limited (tank state feeds Finn's next search, which re-runs on fresh data); note it in the code, don't chase it.
- **Skip-ahead reports** (`next_leg_id` = a later leg while mid-way through an earlier one): out of scope — only the re-pointed leg is ever split. The skipped leg keeps its full original shape in the fold (mild inaccuracy, honest enough).
- **Fragment of a fragment:** can't happen — the merge rule extends rather than re-splits, and a fragment is never the `current_leg`.

## Implementation shape

1. **Pure core** — new `src/lib/penny/legSplit.ts`: `computeMidLegSplit(input) → { kind: 'none' | 'split' | 'extend', drivenKm, splitPoint, prefixGeometry, driveTimeShareMinutes }`. All thresholds and geometry math here; unit-tested with real-ish polylines (incl. no-geometry fallback, near-start, near-end, off-route, extend).
2. **Repo** — `applyTripProgress` calls the pure core before its existing re-point block; on `split` inserts the fragment (+ sort-order shift), on `extend` updates the prior fragment. Returns `splitLegId` in its result so the dispatcher can include it in `result_meta.changes` (keeps the turn log honest — this is how the incident was reconstructed).
3. **Migration 0021** — `split_parent_leg_id`.
4. **Prompt** — `report_position` tool description: add one line ("if the driver stopped partway along a leg, the server preserves the driven portion automatically — do NOT set start coords via update_leg after reporting"). No new Penny smarts; the server owns the behavior.
5. **Tests** — `legSplit.test.ts` (pure), an `applyTripProgress` integration test (split + extend + no-split paths), an `editOverride` no-false-positive case, and an e2e addition to the existing progress flow if cheap.

Order: 1 → 3 → 2 → 4 → 5, `tsc --noEmit` + `npm run test` after each code step. CLAUDE.md schema note updated with the migration.

## Explicitly out of scope

- Multi-day partial representation (two legs on one date).
- Trimming a skipped-over leg to what was actually driven.
- Any UI beyond what the fold already renders (a "partial day" badge is a later nicety, enabled by the new column).
