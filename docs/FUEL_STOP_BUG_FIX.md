# Fuel-Stop Silent Failure — Bug Fix Spec

> **Audience:** A Claude agent picking this up cold. Read `CLAUDE.md` at the repo root first for project orientation, then this document.
>
> **Status:** Diagnosed but not yet fixed. Sam approved the design described below; implementation is open.

---

## The incident (what happened)

On **2026-06-01** Sam created a 53-leg, 90-day trip ("Summer '26 Trip", id `c0c49e75-7349-4eee-a35a-b10a81be25b4`) starting Austin → Big Bend National Park → grand loop of US national parks. He then asked Penny "add a gas stop for day one." Penny responded "Fuel stops are now planned for your Austin to Big Bend drive" — but the UI showed **No stops yet** for Day 1 even after a hard reload.

Investigation via `scripts/debug-trip.ts` (read-only diagnostic — keep this script) confirmed:

- Penny called the correct tool: `{"action":"plan_fuel_stops","leg_id":"840eb681-fd2a-4c02-9d68-be1ef816ffe1"}` (Leg 1 of the trip).
- The trip-wide fuel replenish ran (~22 Google Places API calls executed in the seconds after).
- For Leg 1 specifically, **zero stop rows were written to the DB**. Every other drive leg got fuel stops.
- Penny's text response claimed completion before the deferred planning even ran.

So Sam saw "fuel stops are now planned" + zero stops + no error. The trust-on-the-road failure mode.

This document captures two bugs in the fuel-planning pipeline, plus filed side issues we deliberately did NOT fix in the same commit.

---

## Bug #1 — `findTopGasStations` silently skips on empty Places result

### Where

- `src/server/fuel.ts` — `findTopGasStations` (around line 683).
- `src/server/fuel.ts` — `planFuelStopsForLeg` consumer (around line 254).

### What's wrong

`findTopGasStations` makes a Google Places `searchNearby` call with a fixed radius `SEARCH_RADIUS_KM = 10` (line 59). When Places returns zero results (sparse rural areas, remote desert, Norwegian/Australian outback), the function returns:

```ts
if (places.length === 0) return { ok: true, data: null };
```

— a success with null data. The consumer in `planFuelStopsForLeg` then does:

```ts
if (result.data) {
  pending.push({ kind: 'fuel', distance_km, station, alternates });
}
```

If `result.data` is null, nothing is added to `pending`. After the sample loop, the transaction inserts however many entries are in `pending` — zero, in this case. The leg's `fuel_status` is set to `'ready'`, no error is logged for the user, and the UI shows "No stops yet — fuel stops appear here automatically" forever.

### Why Leg 1 specifically died

- Leg 1: Austin (30.27, -97.74) → Big Bend NP (29.17, -103.24), 769 km, vehicle range 600 km.
- `computeKmBurnedSinceLastRefuel` returns 0 (first driving leg).
- Cumulative skip check: `0 + 769 < 600 × SKIP_PLANNING_THRESHOLD (0.7) = 420` → false, so planning runs.
- `stepKm = 600 × SAMPLE_FRACTION (0.85) = 510`. With `firstStepKm = min(510, 600 × 0.85) = 510`, the polyline gets ONE sample at 510 km along the route.
- 510 km along Austin → Big Bend lands roughly near the Pecos River canyon south of Sanderson, TX — remote West Texas desert.
- `SEARCH_RADIUS_KM = 10` is too tight; Places returns zero `gas_station` results inside that 10 km circle.
- One sample, one empty lookup → leg gets zero stops, silently.

### Project principle being violated

"No silent failures anywhere in the app." This pattern (returning success with null data to a caller that conditionally pushes) is exactly what the principle says to avoid. Worth a follow-up grep across the codebase for similar `if (result.data) push(...)` patterns to confirm this is the only instance.

### Fix: adaptive radius escalation

Sam's proposed design — keep:

1. Start with the existing radius (`10 km`).
2. If Places returns zero results, retry at **25 km**.
3. If still zero, retry at **100 km**.
4. If still zero, retry at **500 km**.
5. If still zero after 500 km, give up — but surface a clear, user-visible warning ("couldn't find fuel stations within 500 km of the planned refuel point"). Mark the leg's `fuel_status` to a new value `'no_stations_found'` with a reason string.

Why this shape:

- Urban / suburban legs hit at 10 km first (status quo, no cost change).
- Rural US, European A-roads, and most Aus/Canadian highway areas resolve at 25-100 km.
- Norway, the Australian outback, Patagonia, Trans-Sahara, and other genuinely sparse regions resolve at 500 km — or trigger a warning the user should act on.
- Worst-case cost: 4 Places "essentials" calls per failing sample point (each ~$0.005 — under $0.02 per truly remote sample). Bounded and cheap.
- The 500 km warning is the actual signal Sam needs for places like Norway where dual fuel tanks exist for a reason — Penny should NOT pretend to have planned a stop she couldn't find.

### Implementation notes

- Add an array constant `PLACES_RADIUS_ESCALATION_KM = [10, 25, 100, 500]` near the existing `SEARCH_RADIUS_KM`. Keep `SEARCH_RADIUS_KM` as the initial value (or replace it with the array's first element) — be careful, it might be referenced elsewhere.
- Refactor `findTopGasStations` to take an optional `radiiKm` parameter (default to the escalation array) and loop through them, returning early on the first non-empty result. Distinguish the new "tried all radii, none found" outcome from the old "data: null" — surface it as `{ ok: true, data: null, exhausted: true }` or similar.
- In `planFuelStopsForLeg`, when ANY sample point returns `exhausted: true`, accumulate a per-leg reason. After the loop, if `pending.length === 0` AND at least one sample was exhausted, set `fuel_status` to `'no_stations_found'` and pass a meaningful `reason` into `setFuelStatus`.
- Add the new status value `'no_stations_found'` to whatever enum/union `fuel_status` uses (search the schema and types).
- UI: where the trip workspace renders "STOPS — No stops yet" (probably `src/components/stops/` — verify), add a branch that, when the leg's `fuel_status === 'no_stations_found'`, shows a warning card with the reason instead of the empty-state copy.

### Acceptance criteria

- Re-running the same trip + "add a gas stop for day one" prompt yields one of two outcomes for Leg 1:
  - (a) Stops are written from a wider-radius Places match.
  - (b) `fuel_status = 'no_stations_found'`, the UI shows the warning, AND Penny's text response acknowledges it.
- No regressions on legs that work today — verify by re-running on a trip with all dense-urban legs and confirming first-radius (10 km) lookups still resolve.
- Add unit tests in `src/server/fuel.test.ts` (or create if it doesn't exist) covering: empty → retry at next radius; all empty → exhausted true; first hit on radius 2; etc.

---

## Bug #2 — Penny claims success before the deferred fuel-planning runs

### Where

- `src/app/api/trip/replan/route.ts` — `plan_fuel_stops` dispatcher case (around line 1027).
- `src/app/api/trips/[id]/route.ts:125` — `replenishFuelStopsForTrip` triggered on trip GET.
- `src/lib/claude.ts` — system prompt section governing fuel-stop responses.

### What's wrong

The `plan_fuel_stops` dispatcher does NOT actually plan fuel stops. It calls `resolvePennyLegIdOnTrip` to validate the leg id and returns. The real planning is deferred: when the client refetches `/api/trips/[id]` after Penny's response, `replenishFuelStopsForTrip` runs and (maybe) writes stops.

This means **when Penny's tool result returns success, no fuel stops have actually been planned yet.** Penny's prose template tells her to say things like "Fuel stops are now planned for your Austin to Big Bend drive" — past tense, claim of completion. She has no information about whether the deferred work succeeded or failed.

This violates `[[feedback_penny_capability_honesty]]` — Penny must never claim a capability or completion that isn't reflected in reality.

### Two fix options

**Option A (preferred): make `plan_fuel_stops` synchronous in the dispatcher.**

In the dispatcher case, after `resolvePennyLegIdOnTrip`, invoke `planFuelStopsForLeg(legId, userId)` inline. Use the returned `FuelPlanResult` to determine what to report back to Penny:

- `status: 'ready'` with stops created → "Fuel stops planned for Day N."
- `status: 'no_stations_found'` (new from Bug #1 fix) → "Couldn't find fuel stations along Day N's route — flagged for manual planning."
- `status: 'failed'` → surface the failure reason in the tool result; Penny relays it honestly.

**Trade-off:** synchronous = Penny waits for Places API (several seconds per sample point) in the tool-use loop. With the new adaptive radius escalation that could be ~10-20 seconds for a remote leg. The wall-clock budget (`MODEL_LOOP_BUDGET_MS = 280_000`) accommodates that, but it does eat into the iteration budget on multi-leg plans.

**Option B (lower-effort): keep the deferred flow, fix Penny's prose template.**

Change the system prompt section that governs `plan_fuel_stops` responses to use future-tense language: "Queued fuel planning for Day N — check the stops list once it refreshes." Then the deferred replenish either populates stops (UI updates) or surfaces the no-stations-found warning. Penny's claim is honest because she's saying she queued it, not completed it.

**Trade-off:** the warning surfaces in the UI but NOT in chat. The user might not associate the empty Day 1 with their gas-stop request. Worse UX than A, but no synchronization cost.

### Recommendation

Do **Option A**. The honesty principle outweighs the speed cost, and with the adaptive-radius fix in place the deferred replenish is also more reliable — running it inline lets Penny report the real outcome including the new warning state. If wall-clock becomes a problem in practice, revisit.

### Acceptance criteria

- `plan_fuel_stops` tool result content contains either "stops_created: N" or "no_stations_found: <reason>" or "failed: <reason>" — never just generic success.
- Penny's text response describes the actual outcome (e.g., "Couldn't find stations along Day 1 — flagged for manual planning" instead of "Fuel stops are now planned").
- A failing leg surfaces both in chat AND in the UI warning state from Bug #1's fix.

---

## What NOT to fix in the same commit

Filed for future work. These were found in the same investigation but are independent bugs.

### Side bug A — Duplicate rest-day add_legs in initial plan build

On the same trip, Penny emitted 2× rest-day `add_leg` calls for Grand Canyon, Yosemite, Seattle, Glacier (3× actually), Yellowstone, Denver, Chicago, Acadia, NYC, Smoky Mountains, Everglades, and New Orleans. One Glacier rest-day entry was malformed (no coordinates, no start/end names). This is likely a system-prompt or `add_leg` validation issue — not a fuel bug. File for a follow-up session.

### Side bug B — Cache-token logging gap in `usage_events`

`src/server/repos/usage.ts:47-58` rolls `cacheCreationInputTokens + cacheReadInputTokens` into the stored `input_tokens` column. The `usage_events` schema has no separate cache columns. Cost is correctly discounted in `cost_microcents`, but cache hit rate isn't recoverable from the data. This is a precursor to the cost-engineering work in `docs/PENNY_COST_ENGINEERING.md` Feature 3 — needed before we can measure cache effectiveness on long trips. Small migration + repo change.

### Side bug C — `penny:continuity-repaired-noroute` event on Leg id `35ff2c46-...`

One leg failed continuity repair because it had no route. Surfaced as a `penny:continuity-repaired-noroute` event with `success: false` in `usage_events`. Worth investigating separately — not in scope for the fuel fix.

---

## Verification workflow

After implementing Bug #1 + Bug #2 fixes:

1. `npx tsc --noEmit` — must pass.
2. `npm run test` — must pass; add the new unit tests for the radius escalation.
3. Manual smoke: hit the existing Summer '26 Trip (it's still in the DB) and re-run "add a gas stop for day one." Use `scripts/debug-trip.ts --name "Summer '26 Trip"` to confirm:
   - Day 1's leg either gets stop rows OR has `fuel_status = 'no_stations_found'`.
   - Penny's response text matches the actual outcome.
4. Commit per the CLAUDE.md workflow (Claude commits to `main`, Sam ships). Keep the commit scoped to the fuel-planning fix; do NOT sweep in the filed side bugs or unrelated edits.

---

## State at handoff

- `scripts/debug-trip.ts` is a working-tree file, **not yet committed**. It's a read-only diagnostic — useful enough to keep. Commit it as part of the same fix or as a tiny precursor commit, either way is fine.
- Sam's `main` has uncommitted staged changes (`Itinerary.tsx`, `dates.ts`, `dates.test.ts`) and a stash (`WIP admin announcement button`) from earlier work — **resolve or set aside before committing this fix.** Per [[user_multi_agent_git_workflow]], be careful not to sweep stranded work into this commit.
- `docs/PENNY_COST_ENGINEERING.md` is the related but separate cost-engineering spec. Bug #2 here doubles as a small piece of evidence that the cost-engineering measurement work (Feature 3 in that doc) needs to ship before more speculative features.

---

## Memories to honor

- **No silent failures anywhere in the app.** This is the project value being violated.
- `[[feedback_penny_capability_honesty]]` — Penny never claims a capability or completion that isn't reflected in reality.
- `[[feedback_fuel_safety_bias]]` — fuel planner must bias conservative. A silent "0 stops written" is the worst-case violation: an empty plan that LOOKS safe.
- `[[feedback_prefer_simple_deterministic]]` — adaptive radius escalation is deterministic; the warning surfacing is deterministic. Both are aligned with this preference.
- `[[feedback_flag_stale_code.md]]` — if you find dead helpers around the old fuel-planning code while doing this, tell Sam.
