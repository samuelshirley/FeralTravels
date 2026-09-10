# Task: ship the Haiku switch, fix the fuel tank-walk, stop Penny authoring derived fields

Read CLAUDE.md first — its "Reproduce, never guess" and "Playwright MCP — use it FIRST"
sections apply to every step below. Do not paraphrase a cause from a comment; make it happen.

## 0. Where things stand (measured 2026-09-09, session 014Ut9oTS89Cv13s5C6Hkjem)

- `scripts/anthropic-usage-report.ts` (committed as `0c917b3` on `feat/paywall-auth-and-chat`)
  proved our cost math matches Anthropic's billing to the cent; the missing 92% of spend was CI
  previews billing the production key because Vercel Preview never had `ANTHROPIC_API_KEY_CI`.
- UNCOMMITTED in the working tree, and part of THIS task:
  - `src/lib/models.ts` — `PENNY_MODEL` is now `claude-haiku-4-5-20251001` (was `claude-sonnet-4-6`).
  - `src/lib/claude.ts` — `ReplanResult.toolTrace: string[][]` (tool names per model call).
  - `src/app/api/trip/replan/route.ts` — `toolTrace` + `modelCalls` added to the applied payload,
    so they land in `penny_turns.result_meta`.
  - NOT part of this task, leave untouched and uncommitted: `docs/design/launch-checklist.md`,
    `scripts/iap-preflight.sh`, `scripts/iap-webhook-secret.sh`, the `_to_delete/` folder.
- Replay results, same prompts, same account flow (prod DB, `next dev`, CI key):
  | prompt | Sonnet (2026-09-08) | Haiku (2026-09-09) |
  |---|---|---|
  | "all the national parks in the American west, from Austin, 2 weeks", 8 Oct, 8 h | 1 turn, 37 model calls, 194 s, $0.585, 14 legs, 3 tasks (trip `328d14af`) | 2 turns, 6 calls, 75 s, $0.085, 13 legs, 0 tasks (trip `ab824cde`) |
  | "3 closest parks over a week", 8 Oct, 6 h | 3 turns, 44 calls, $0.494 (trip `41a863f9`) | 1 turn, 10 calls, 62 s, $0.061, 7 legs (trip `1b1cc80b`) |
  Haiku obeyed `<batching_for_multi_waypoint_trips>` (all resolve_place in one call, all get_route
  in one, all add_leg in one); Sonnet went one at a time. Haiku regressions, all fixed below:
  wrong titles on split days ("Austin → Big Bend (Day 1)" on a leg ending in Marfa), invented
  split-point names ("Texas Panhandle", "Albuquerque area"), `rename_trip` without `end_date`
  (trip `ab824cde` has `end_date` NULL), no leg notes/tasks (accepted — post-MVP).
- THE BUG THAT MATTERS (trip `ab824cde`, leg sort_order 11, "Monument Valley → Texas Panhandle"):
  `fuel_status = 'no_stations_found'`, `fuel_plan_error = "Next fuel is 44 km ahead — beyond safe
  range (-1896 km)…"`, vehicle `range_km = 500`. Cause, reproduced from the code path:
  `computeKmBurnedSinceLastRefuel` (`src/server/fuel.ts`) walks earlier legs for the last fuel
  stop; legs 9, 7, 5, 4, 2 have none because they were NEVER OPENED (lazy day-open sourcing), so
  it reaches leg 0's stop and reports 2,396 km burned → 500 − 2396 = −1896. `planLegFuelStops`
  (`src/lib/finn/plan.ts` ~line 100) then finds no "safe" candidate and emits the gap message,
  which `server/fuel.ts` files as the 48h-cached `no_stations_found`.

## 1. Branch and commit what exists

The Haiku/toolTrace edits are UNCOMMITTED on `feat/paywall-auth-and-chat`'s working tree, beside
edits that are not ours. Move exactly those three files to a fresh branch off real `main`:

```bash
git fetch origin
git stash push -- src/lib/models.ts src/lib/claude.ts src/app/api/trip/replan/route.ts
git switch -c feat/haiku-and-fuel-tank-walk origin/main
git cherry-pick 0c917b3        # the Admin API report + Haiku 4.5 price fix; must apply clean
git stash pop
git diff --stat                # exactly the three files; models.ts reads claude-haiku-4-5-20251001
npx tsc --noEmit && npm run test
```
Commit as `feat(penny): Haiku, and a tool trace on every turn` — the body carries the replay
table from section 0.

Add `src/lib/models.test.ts`: fails if `PENNY_MODEL` is not a `claude-haiku-*` id. A model change is
a 3× cost decision and must be made in a test, on purpose. Mutation-check it (set Sonnet, watch red).

## 2. Fuel tank-walk fix (P0 — the app shows a driver wrong fuel information)

Reproduce FIRST: `npm run dev`, open trip `ab824cde-6fdf-4485-9059-e91c60794d51` (your account),
expand "Monument Valley → Texas Panhandle", see the warning. Then, with the Playwright MCP, the
same on the preview once it exists. Do not start coding until you have seen it.

Then, in this order:

a. **Structural guard, pure, in `src/lib/finn/plan.ts`**: if remaining range at the leg start
   (`rangeKm − burnedKmAtStart`) is `<= 0`, `planLegFuelStops` returns a DISTINCT outcome
   (e.g. `{ kind: 'tank_state_invalid', burnedKm, rangeKm }`), never the gap message. The
   sentence "Next fuel is N km ahead — beyond safe range (−M km)" must be impossible to produce.
   Unit test in `plan.test.ts`; mutation-check by deleting the guard.

b. **Dependency cascade in `src/server/fuel.ts`**: before planning leg N, find every DRIVE leg
   between the last leg that has a real (non-dismissed) fuel stop and N whose `fuel_status` is
   `none` or `failed`, and source them oldest-first through the existing `planFuelStopsForLeg`
   (respect `computing`/`pending` — another request may hold them; wait or bail with `failed`,
   never double-plan). **CORRECTION 2026-09-09 (this brief's first draft was wrong, and the note
   written into CLAUDE.md by commit 357726d repeats the error — fix that note):** Finn is NOT on
   OSM/OSRM. Commit `a0c9ee6` (2026-07-22) removed OSM, OSRM and fuel pricing; station search is
   Google Places (New) Text Search along-route (`src/lib/google/places.ts`) and route geometry is
   Google Directions. Both are PAID. The cascade therefore multiplies paid calls: opening day 12
   cold on a 12-day trip can be up to ~6 Places searches instead of 1. It is still the right fix —
   a wrong fuel warning is worse than a few cents — but its cost is measured, not assumed:
   `logGooglePlacesUsage` in `repos/usage.ts` has had NO caller since 2026-06-29 (last
   `google-places` row in prod). Re-wire it in `places.ts`/`server/fuel.ts` so every Places and
   Directions call writes a `usage_events` row, then report the per-day-open and per-cascade
   call counts in the PR body, alongside the Google Cloud console's SKU usage for the same window
   (the pricing is per-SKU with monthly free tiers — read the number from the console, do not
   quote a price from memory). Extract the "which legs must be sourced first" decision into a PURE function
   (`src/lib/finn/sourcingOrder.ts` or similar) and unit-test it: opening day 12 with days 3–9
   unsourced yields [3,…,9]; a real fuel stop on day 6 yields [7,…,9]; rest days are skipped;
   a `computing` leg is reported, not returned.

c. **Also correct every remaining OSM/OSRM/"free" claim in CLAUDE.md** (`grep -n "Overpass\|OSRM\|tankerkoenig\|fuelPricing\|free OSM" CLAUDE.md` — ten hits at last count): the Stack section, the Finn cutover note, the lazy-sourcing note, the `failed`-legs-re-source note. Present tense, Google Places + Directions, paid.

c2. **`tank_state_invalid` maps to `failed`** (retryable, no 48h cache), with a log row to
   `usage_events` (`finn:fuel-plan`, success=false) so it shows in /admin/errors. It should be
   unreachable after (b); the log is how we find out if it isn't.

d. **UI: a day that needs no stop reads as a positive state**, web and native, matching the UI
   (no emoji, no warning colour): the existing native copy "No fuel stop needed on this day — it
   fits within the fuel you have left." is the line; confirm the web `StopsSection` renders the
   same for `ready` + 0 fuel stops and that neither platform ever shows the `no_stations_found`
   warning for a leg whose planner outcome was "none needed". Component tests for both
   (`StopsSection.test.tsx`; native via a source-text guard in `src/lib/`, as the repo does).

e. **E2E in `e2e/lazy-fuel-sourcing.spec.ts`**: seed a fixture trip with three 400 km drive
   legs and a 500 km range (see `seedCanonicalFixture`'s `rangeKm`), open DAY 3 FIRST, assert it
   ends `ready` with ≥1 fuel stop and that days 1–2 became `ready` too, and assert the page never
   contains "No fuel stations found". Mutation-check by disabling the cascade.

f. Re-open the real leg on `ab824cde` after the fix (dev, then preview) and confirm the warning
   is gone and a stop is placed. Put the before/after `fuel_status` rows in the PR body.

## 3. Penny stops authoring derived fields (the LLM converts, it does not author)

a. **Split-point names**: `executeGetRoute` (`src/lib/claude.ts`) returns `suggested_split` as
   lat/lng only; Penny invents the town. Reverse-geocode each split point SERVER-SIDE and return
   `end_name` with it. Check FIRST whether the one Google key has the Geocoding API enabled
   (`curl` a reverse geocode with it — CLAUDE.md records a REQUEST_DENIED outage on a legacy
   Places SKU; do not assume). If denied, use Nominatim (`nominatim.openstreetmap.org/reverse`,
   identifying `User-Agent` mandatory, 1 req/s) and note the source. Tell Penny in the prompt to
   use the returned names verbatim. Test: `getRoute` result carries a non-empty `end_name` per
   split; validator rejects an `add_leg` whose start/end coords match a split point but whose
   name doesn't (or, simpler and stronger: the dispatcher overwrites the name from the split).
b. **Drive-leg titles are derived**: for `leg_type='drive'`, title = `${start_name} → ${end_name}`
   computed in the repo on insert/update; drop `title` from `add_leg`/`update_leg` for drive legs
   (rest legs keep theirs). Fix the four wrong titles on `1b1cc80b` by re-deriving. Unit test.
c. **`trips.end_date` is derived from the legs** after every apply (last leg's date), never taken
   from `rename_trip`. Backfill `ab824cde`. Unit test on the pure derivation; assert
   `rename_trip`'s schema no longer carries `end_date`.
d. `resolve_place` returns the formatted address (with state/country); store that as the leg's
   name so "Monument Valley" reads "Monument Valley, AZ" — check what the Places response already
   gives before adding anything.

Update CLAUDE.md in the same commits (Scripts, the lazy-fuel note, the Penny-tools note, the
model line under Stack) — it is mandatory there.

## 4. Validate, PR, and what "done" means

- After EVERY change: `npx tsc --noEmit && npm run test`. Both green before each commit.
- Commits scoped per section (1, 2, 3); attribution lines from CLAUDE.md conventions apply.
- `git push -u origin feat/haiku-and-fuel-tank-walk`, then
  `gh pr create --fill --title "Penny on Haiku; fuel tank-walk cascade; derived leg fields"` with a
  body that carries the replay table, the −1896 km reproduction, and the before/after rows.
- Add the **`ai-tests`** label (`gh pr edit --add-label ai-tests`) — `penny-plan-trip` and
  `chat-maps-link` must run on Haiku, and the deploy gate reads that run. If they red, that is
  the finding; do not loosen them.
- On the preview URL (sticky PR comment), with the Playwright MCP: run the Austin prompt through
  onboarding, then `GET /api/trips/<id>/turns?key=<idempotencyKey>` and confirm `result_meta`
  carries `toolTrace` and `modelCalls`; open day 12 first and confirm no fuel warning.
- Report: the PR URL, the CI run, the three trace/call counts, and anything you could not
  reproduce — stated as such, not explained away.
