# check_trip_feasibility — input integrity

**Status:** suspected (architectural risk, not yet observed)
**Noted:** 2026-05-04, during the scale-fix work that introduced `check_trip_feasibility`
**Last reviewed:** 2026-08-20 — still valid, none of the mitigations below have been built

> Moved here from the repo-root `possible-bugs/` folder on 2026-08-20. That folder held
> exactly this one file, went unreviewed for three months, and its own README warned
> against becoming a graveyard — so it was removed and the live risk filed with the rest
> of the design notes.

## Where it lives

- `src/lib/penny/tools/checkTripFeasibility.ts` — the tool definition and the pure `computeFeasibility()` function
- `src/lib/claude.ts` — `executeCheckTripFeasibility()` runs the tool, records the verdict on `ReplanResult.feasibilityVerdict`
- `src/app/api/trip/replan/route.ts` — the dispatcher gate that rejects `add_leg` actions when the verdict is missing or `over_budget`

## The mechanism

`computeFeasibility()` does its arithmetic in deterministic JavaScript — that part is correct by construction. The risk is upstream: **Penny fills in the inputs herself**, and she could fill them in wrong. The tool will then compute a perfectly correct verdict on incorrect data.

Possible upstream errors, ordered roughly by likelihood:

1. **Off-by-one segment.** Penny calls `get_route` four times but passes only three entries to `segment_drive_days`. Or passes five (double-counts a segment).
2. **Wrong nights array.** User said "Smoky 2 nights, Grand Canyon 3 nights, Moab 2 nights" → 7 total. Penny passes `[2, 3, 2]` which is correct, but she could just as easily pass `[2, 3]` (forgot one) or `[1, 3, 2]` (misread).
3. **Wrong `time_budget_days`.** "Two weeks" parsed as 13 or 21 instead of 14. Or `null` when the user actually said "in two weeks".
4. **Stale data after revision.** User says "extend to 21 days, drop Moab." Penny calls `extract_trip_intent` again with the new inputs, then calls `check_trip_feasibility` but accidentally passes the OLD `waypoint_nights` array.
5. **Schema-valid garbage.** All values are within the Zod bounds (1-60, 0-30, etc.) but bear no relation to the actual `get_route` results from earlier in the turn. The validator can't catch this — it's a semantic error, not a structural one.

The bounds in the schema (segment days 1-60, nights 0-30, max 200 segments, max 50 waypoints) reject obvious garbage like negative numbers or thousand-element arrays. They do **nothing** against plausible-but-wrong values.

## Why it matters

The feasibility check is the gate that decides whether `add_leg` actions get persisted. Wrong inputs flip the verdict. The two failure directions hurt differently:

- **False `fits` / `tight`** (sum is too low): An over-budget plan slips through the gate and gets saved. The user sees a 19-day plan against their stated 14-day budget — exactly the bug we built this whole system to prevent. Trust regression.
- **False `over_budget`** (sum is too high): A perfectly feasible plan is rejected. The user sees "Plan rejected — exceeds your time budget" for a trip that does fit. They retry, maybe Penny gets it right the second time, maybe she doesn't. Annoying but recoverable.

The first case is the one that erodes trust silently. The second case shows up as friction the user notices.

## Symptoms — user-facing

What you (or a user) would see:

- **Trip totals don't match what Penny said.** Penny's chat says "12 driving days + 7 nights = 19 days, fits your 21-day budget" but the dashboard `TOTAL DAYS` shows 23. (**Updated 2026-08-20:** the `TOTAL DAYS` follow-up proposed here has shipped. `lib/penny/planSummary.ts` derives `total_days` deterministically from the DB and the plan summary card displays it, while Penny's prose is now forbidden from stating plan numbers at all. That makes this the cleanest available tell: her qualitative claim that a plan "fits" sitting next to a card whose day count exceeds the stated budget.)
- **Plan saves successfully but obviously over-budget.** User said "two weeks", chat shows "fits", but counting legs in the dashboard adds up to clearly more than 14 days of driving + nights.
- **"Plan rejected" errors on trips that should clearly fit.** User asks for a 21-day Tampa→Seattle with three short stops and gets the rejection banner. They re-prompt with the same content and it goes through. (Indicates the first attempt had bad inputs; the retry got them right.)
- **Penny revises a plan and lands wrong.** User says "drop Moab, extend to 18 days." Penny says "fits now". Dashboard still shows 21 days of work because the new inputs to `check_trip_feasibility` were stale.
- **Multiple feasibility calls per turn with conflicting verdicts.** Less likely to be user-noticed directly, but if Penny calls the tool twice (e.g., once with a typo, once corrected) the user might see her flip between "over budget" and "fits" mid-response.

## Symptoms — developer-facing

What you'd see in logs, the DB, or the admin view:

- **`usage_events` for `provider = 'anthropic:replan'` show `failedActions` clusters of `add_leg` rejections.** Already-known signal that the dispatcher gate fired. If you see lots of these on plans that look like they should fit, the upstream inputs are wrong (false `over_budget`).
- **`usage_events` for `provider = 'anthropic:replan-truncated'` (added in the earlier round) drop, but trip-quality complaints rise.** Indicates Penny is no longer running out of room — but the quality of what she's saving is suspect.
- **Trips in the DB whose leg count exceeds their own date window.** A SQL check surfaces these. **Corrected 2026-08-20 — the original sketch here was broken:** it cast `trips.start_date` / `end_date`, which are the ORIGINAL free-text columns and hold things like `"late May"`; they will not cast to `date`. The machine-readable columns are `start_date_parsed` (NOT NULL) and `end_date_parsed` (nullable — many trips are open-ended). Both are already `date`, so subtracting them yields an integer with no cast:
  ```sql
  -- Trips whose leg count exceeds the machine-readable date window
  SELECT t.id, t.name,
         COUNT(l.id) AS leg_count,
         (t.end_date_parsed - t.start_date_parsed + 1) AS budget_days
  FROM trips t
  JOIN legs l ON l.trip_id = t.id
  WHERE t.end_date_parsed IS NOT NULL
  GROUP BY t.id, t.name, t.start_date_parsed, t.end_date_parsed
  HAVING COUNT(l.id) > (t.end_date_parsed - t.start_date_parsed + 1);
  ```
  The May caveat about nights is **also obsolete**: overnight stays are materialized as first-class `legs` rows with `leg_type = 'rest'` (see `lib/penny/schedule.ts`), so one leg is one calendar day and `COUNT(l.id)` covers driving days *and* nights. The proposed `overnight_nights` column isn't needed. Remaining caveat: the query only catches trips where the user actually supplied an end date.
- **Chat history with `assistant` messages that say "fits" followed by the same trip getting `add_leg` rejections two turns later.** Indicates Penny re-checked and got a different answer — the first set of inputs was likely wrong.
- **Discrepancy between `extract_trip_intent`'s `time_budget_days` and `check_trip_feasibility`'s `time_budget_days` in the same conversation.** These should always match within a turn. If they don't, Penny restated the budget.

## How to detect

Two paths, ordered by cost-to-build:

**Cheap — passive observation.** Use the existing `usage_events` log to count add_leg rejections per day after this lands. If the rate is low and stable, the prompt rule is doing its job. If it spikes, dig into the recent failed-action chat threads.

**Medium — log every check_trip_feasibility call.** Add a `logUsageEvent` in `executeCheckTripFeasibility` (similar to the truncation log we already have) capturing inputs and verdict. Then you can run queries like "how often does Penny submit input arrays of mismatched length?" or "how often does the verdict change between two calls in the same turn?". Cheap to add, makes the rest of these symptoms grep-able.

**Expensive but right — server-side cross-check.** The `replan()` loop already has the tool-use history in `messages`. We could, before recording the feasibility verdict, walk back through the turn's tool_results, extract every `min_driving_days` from the `get_route` results and every `nights` from the `extract_trip_intent` result, and compare them to what Penny passed to `check_trip_feasibility`. If they don't match, override the verdict (or refuse to record one) and force Penny to retry. This is the bulletproof fix; it's expensive because the dispatcher has to inspect message contents, which couples it to the tool result schemas.

## How to fix (when it becomes a real problem)

The expensive option above is the right architectural fix. Sketch:

1. In `replan()`, when iterating tool_uses, record per-turn dictionaries: `getRouteResults: Map<toolUseId, { min_driving_days }>` and `extractIntentResult: { waypoint_nights[], time_budget_days }`.
2. When `executeCheckTripFeasibility` is called, validate Penny's inputs against those recorded results:
   - `segment_drive_days.length` must equal `getRouteResults.size`
   - `segment_drive_days` values must match the `min_driving_days` set in those results (allowing for any order — sort both arrays and compare)
   - `waypoint_nights` must equal `extractIntentResult.waypoint_nights`
   - `time_budget_days` must equal `extractIntentResult.time_budget_days`
3. If any mismatch, return `is_error: true` from the executor with a precise message ("segment_drive_days has 3 entries; expected 4 from your get_route calls in this turn"). Penny will see the error and re-emit a corrected call (the validation-retry loop already handles this).

That turns the input-integrity problem from "trust Penny's arithmetic" to "trust Penny to copy three numbers correctly", and even the latter is verified.

A lighter version that catches the most common bug: just check `segment_drive_days.length === count_of_get_route_calls_this_turn`. That alone would catch off-by-one errors.

## What I'm watching for

In rough priority order, the things that would convince me to promote this from "suspected" to "confirmed":

1. Any user complaint of the form "Penny said it fits but the plan is way longer than I asked for."
2. `failedActions` rate climbing without a corresponding rise in `extract_trip_intent` calls (suggests Penny is consistently failing the gate on plans she should be able to satisfy).
3. A reproducible case where the same user prompt produces different verdicts on different runs — that's evidence the inputs to the feasibility tool aren't stable.

## History

- 2026-05-04 — Noted at the time the feature shipped. Not yet observed in the wild. Review again after the change has been in production for a couple weeks of real use.
- 2026-08-20 — **First actual review** (the two-week one above never happened). Re-read against the current code; still valid, status unchanged at `suspected`. Verified:
  - The gate is intact and unchanged: `api/trip/replan/route.ts` still rejects every `add_leg` when `extractIntentCalled` is true and `feasibilityVerdict` is `null` or `over_budget`.
  - `executeCheckTripFeasibility` (`lib/claude.ts`) still does Zod-parse → `computeFeasibility` → return verdict, with **no** cross-check against the turn's own `get_route` results, **no** `usage_events` logging of the inputs, and not even the cheap `segment_drive_days.length === get_route call count` check. All three mitigations proposed above remain unbuilt.
  - `checkTripFeasibility.test.ts` has 13 specs, every one of them on `computeFeasibility` arithmetic and none on input provenance — which is precisely this file's thesis: the math is correct by construction, the inputs are not.
  - Two sections were stale and have been corrected in place: the detection SQL (wrong columns) and the `TOTAL DAYS` symptom (that follow-up shipped).
  - Still no confirming evidence from production either way — none of the three promotion triggers under "What I'm watching for" has been checked against real `usage_events` data. That check, not another code re-read, is what should happen next.
