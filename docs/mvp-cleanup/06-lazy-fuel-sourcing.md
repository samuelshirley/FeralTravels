# 06 — Lazy fuel sourcing

**Size:** Large · **Risk:** Medium · **The core architectural fix**

**Problem:** fuel stops are sourced **eagerly** — every leg gets Google Places calls during/after the initial plan. CLAUDE.md's MVP design says the opposite: lazy on day-open, cached with a timestamp. That design **is not built**. This is the root cause of the Google API spend Sam saw ("all gas stops sourced from the initial trip planning part").

## Current eager triggers (remove these)

1. **Post-turn replenish:** `actionShouldTriggerTripFuelReplenish()` (`src/app/api/trip/replan/route.ts:163-177`) returns true on any add/update/delete leg, report_position, or fuel add_stop → sets `fuelReplenishQueued` (`:580-582`, sent to client `:639`) → client immediately calls `replenishFuelStops()` (`src/components/ChatPanel.tsx:995-1000`), which loops **every** leg.
2. **Workspace auto-effect:** `TripWorkspace.tsx:310-355` watches leg fingerprints, debounces 3s, calls `handleReplanFuel` → `replenishFuelStops` (`:495-519`) — re-runs the whole trip's fuel on any leg edit.

## The lazy endpoint already exists
`POST /api/legs/[id]/fuel-stops` → `planFuelStopsForLeg(legId, userId)` (`route.ts:28`). It's lazy-capable today; nothing calls it on day-open. `planFuelStopsForLeg` itself (`src/server/fuel.ts:109-290`, Places in `fuelPlaces.ts`) works — don't touch the algorithm.

## Target design

1. **Build the skeleton eagerly, fuel lazily.** Initial plan creates legs/routes only. No fuel calls during the plan turn. Remove/guard both eager triggers above.
2. **On day-open, fetch fuel for that leg.** When the user expands a day in the itinerary (`Itinerary.tsx` / `src/components/stops/StopsSection.tsx`), call `POST /api/legs/[id]/fuel-stops` for that leg only — no button (per CLAUDE.md).
3. **Cache with a timestamp.** Persist fuel stops + a `fuel_stops_updated_at` per leg. On day-open: fresh cache → render; **stale** cache → cheap price/availability re-check rather than a full re-search; empty → full search. (No caching exists today — this is new. Pick the staleness window, e.g. 24–72h.)
4. **Finn contract is ready:** `comfortable_range_km` + `hard_max_range_km` already projected via `projectVehicle` (`hard_max ?? comfortable`). Lazy call passes both; Finn treats hard_max as the never-exceed ceiling and attaches a forced-stop reason for geography-forced top-ups (per CLAUDE.md — out of scope to *build* here, but the interface must carry both numbers + the reason field).

## Watch-outs
- `report_position` / leg edits should invalidate only the **affected** leg's cache, not re-fan-out the whole trip.
- Don't silently swallow a failed lazy fetch — surface inline error per the no-silent-errors rule.
- Keep the "forced-stop reason" string as a first-class field even though Finn's algorithm is a separate task.

## Done when
- A fresh full-trip plan makes **zero** Google Places fuel calls until a day is opened (verify via `usage_events` / network).
- Opening a day fetches that day's fuel once; reopening hits cache; stale triggers a cheap re-check.
- Eager triggers (ChatPanel replenish, TripWorkspace auto-effect) are gone.
- `npm run test` + `tsc --noEmit` pass; update CLAUDE.md to mark the lazy+cache design as built.
