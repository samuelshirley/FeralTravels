# Bug — `penny:continuity-repaired-noroute` is logged but not surfaced to the user

> **Audience:** A Claude agent picking this up cold. Read `CLAUDE.md` at the repo root first for project orientation, then this document.
>
> **Status:** Diagnosed, not fixed. Verified still present against `main` HEAD `62a4d79` on 2026-06-01. Requires investigation before deciding the exact fix shape.

## Where

- `src/app/api/trip/replan/route.ts:517` — where `penny:continuity-repaired-noroute` is logged with `success: false` and the leg's geometry cleared.
- `src/app/api/trip/replan/route.ts:530` — adjacent `penny:continuity-repair-failed` provider for the catch-all case.
- `src/lib/penny/schedule.ts` — `repairLegContinuity` lives here (referenced from CLAUDE.md as `computeStartFixes`).
- **NOT found**: no UI surfacing of either event. Grepped `src/components/` and `src/app/trips/` — nothing.

## What's wrong

After Penny's tool actions are applied, the deterministic leg-continuity repair runs (`repairLegContinuity` in `src/lib/penny/schedule.ts`). For each leg it tries to re-anchor the start to match the previous leg's end. For each result it logs one of:

- `penny:continuity-repaired` with `success: true` — leg was successfully re-routed.
- `penny:continuity-repaired-noroute` with `success: false` — re-route failed; **the leg's distance, drive time, and geometry get CLEARED** as a fallback (see the error message at line 521-522: `"re-route failed — distance/time/geometry cleared"`).

The user-facing problem: a leg in this state renders as a card with no distance, no drive time, and no route line on the map. **But there is no warning telling the user that this happened or why.** The card just looks broken. That's a silent failure mode — exactly the kind the "no silent failures anywhere in the app" project value forbids.

### Known instance

On the Summer '26 Trip (`c0c49e75-7349-4eee-a35a-b10a81be25b4`), this fired on leg `35ff2c46-404f-43f8-a6c5-...` (Glacier National Park → Old Faithful, Yellowstone, sortOrder around 18). One usage_event row with `provider = 'penny:continuity-repaired-noroute'`, `success = false`, `errorMessage` starting with that leg id.

## Diagnosis steps before fixing

This bug needs investigation first — the fix shape depends on the root cause:

1. Read `repairLegContinuity` in `src/lib/penny/schedule.ts`. What does "re-route failed" actually mean? Is it a Google Directions API failure? A coordinate validation failure? A logic branch that gives up on certain inputs?
2. Pull the actual leg from the DB:
   ```sql
   SELECT id, sort_order, title, start_name, end_name,
          start_lat, start_lng, end_lat, end_lng, distance_km, drive_time_minutes
   FROM legs
   WHERE id = '35ff2c46-404f-43f8-a6c5-...';
   ```
   (Get the full uuid from `scripts/debug-trip.ts --name "Summer '26 Trip"`.)
3. Plot the start and end coords in Maps. Is it a coord-invalid issue? Cross-country routing issue? Bad data from Penny's add_leg?
4. Look at the leg that came BEFORE this one (sortOrder one lower). The repair tries to anchor THIS leg's start to the PREVIOUS leg's end. The mismatch between those two points is the input to the repair attempt — what's that distance?
5. Decide: is this caused by an upstream bug (Penny emitting weird coords; see also `docs/bugs/addleg-rest-validation.md` for related malformed-data issue), or is it a true edge case where re-routing genuinely can't proceed?

## Fix shape — two paths depending on diagnosis

### Path A — coordinate / data issue upstream

If the leg's coords are genuinely bad (e.g., a rest leg with missing coords from the related Bug in `addleg-rest-validation.md`), fix the upstream cause and this should stop firing.

### Path B — genuine edge case, must surface to user

If routing legitimately can't complete (e.g., points that Google Directions can't route between), add user-facing warning:

1. Add a new column or jsonb field to `legs` (or reuse an existing status column) to track `continuity_warning: { reason: string } | null`.
2. When `repairLegContinuity` falls into the noroute branch, set this field instead of just clearing geometry silently.
3. In `src/components/Itinerary.tsx` (and any related leg-card components in `src/components/`), render a warning badge / text on legs with `continuity_warning != null`. Copy something like: *"Couldn't route this leg automatically — coordinates may need updating."*
4. Penny's next replan should be told (via context.legs[i]) that this leg has a continuity warning so she can offer to fix it.

Probably you need a mix of both: fix the upstream cause IF it's a malformed leg, AND add the surfacing for genuine routing failures since this WILL happen on real trips (e.g., points on opposite sides of major water bodies without ferries enabled).

## Acceptance criteria

- The Glacier → Yellowstone leg on the Summer '26 Trip either gets repaired properly OR has a visible warning on its card.
- If Path B (surfacing) is chosen: the warning is visible in the Itinerary UI, and the warning text states the actual cause in plain language.
- A unit test in `src/lib/penny/schedule.test.ts` covers the noroute branch and asserts the warning state is set.
- Future `penny:continuity-repaired-noroute` events in `usage_events` correspond to legs that have the warning state set in the DB.
- Document the chosen behavior in a comment near `repairLegContinuity`.

## State at handoff

- `scripts/debug-trip.ts` is a read-only diagnostic written during the original investigation. **Not yet committed.** Use it to grab the full leg uuid and see the existing usage_event row for the noroute failure on Summer '26.
- Sam's `main` may have uncommitted staged changes from earlier sessions — check `git status` before starting. Per `[[user_multi_agent_git_workflow]]`, resolve or set aside before committing.
- Related docs: `docs/bugs/addleg-rest-validation.md` — the malformed-rest-leg validator hole may be an upstream cause of this. Worth coordinating if both are being worked on simultaneously.

## Memories to honor

- **No silent failures anywhere in the app** — this is the principle being violated.
- `[[feedback_penny_capability_honesty]]` — if the leg can't be routed, the user should know. Cleared geometry without explanation is the opposite of capability honesty.
- `[[feedback_prefer_simple_deterministic]]` — prefer Path A if possible (fix the upstream cause deterministically) over Path B (add new UI state).
