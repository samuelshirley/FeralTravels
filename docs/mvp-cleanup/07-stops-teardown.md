# 07 — Stops teardown (reduce stop types to the MVP minimum)

**Size:** Medium · **Risk:** Medium (the stops system is entangled — `rest` name collides with rest-day leg type; `overnight` is wired into route-option picking) · **Status:** NOT STARTED — spec only.

## Why

The app's whole job now is *"generate the steps of a trip + the gas stops along it. Nothing else."* (Sam, 2026-06-26). The `stops` table still carries amenity place-types that are pure scope creep — a **groceries** finder (`food`) and a **parks** finder (`rest`). Those need to go, along with the finders behind them.

This is the follow-on to the dump-station removal, which is **already done** (the `dump_station` stop type + `server/dump-stations.ts` + `server/places/nearby-dump-stations.ts` + `api/stops/[id]/find-alternative` were deleted; see `01-onboarding-teardown.md` notes in CLAUDE.md). Do NOT redo that.

## Current stop types

`StopType` (`src/types/trip.ts`): `'fuel' | 'food' | 'overnight' | 'rest' | 'other'`.

| type | what it is | verdict |
|---|---|---|
| `fuel` | gas stops — the core product | **KEEP** |
| `other` | "force the route through this point" (landmarks/passes/"go via X"); selected `other` stops become `&waypoints=` in the leg's Google Maps URL | **KEEP** — it's part of building the route itself |
| `overnight` | where you sleep each night; wired into the route-option picker (`useStopActions.ts`, `StopsSection.tsx` splits `overnightStops` vs `waypointStops`) | **DECISION NEEDED** (see below) |
| `food` | groceries — amenity | **REMOVE** |
| `rest` | parks — amenity, backed by the `nearby-parks` finder | **REMOVE** |

### ⚠️ Decision to confirm with Sam before starting

- **`overnight`:** is "where you sleep each night" a trip step we keep, or also out? It's the most wired of the bunch (route-option selection + a visual variant in `StopCard`). Removing it is a real surgery (`useStopActions.ts` lines ~130/189/201, `StopsSection.tsx` lines ~113/123/124, `StopCard` `variant='overnight'`). **Recommendation: KEEP for now** — a multi-day trip's "steps" include where each day ends.
- **`other`:** keep (route waypoints). If Sam wants *pure* fuel-only, removing `other` means `add_stop` becomes fuel-only and the "go via X" routing primitive dies — bigger change, reworks the `<route_vs_stop_decision>` section of the Penny prompt.

This doc is written for **remove `food` + `rest`, keep `fuel`/`overnight`/`other`**. Adjust if Sam says otherwise.

## ⚠️ Naming-collision trap (read this twice)

`'rest'` is **overloaded**:

- **`leg_type: 'rest'`** = a rest **day** (a non-driving day at a location, e.g. "2 nights in Innsbruck"). This is a legit trip step — **DO NOT TOUCH IT.** It lives in `addLeg`/`updateLeg` (`leg_type` enum), `schedule.ts`, `planSummary.ts`, `legSegmentGrouping.ts`, `Itinerary.tsx`, etc.
- **`stop_type: 'rest'`** = a park/rest-area stop (label "PARK"). **This** is the one to remove.

When editing, only touch `stop_type`/`StopType` occurrences of `'rest'`. Never the `leg_type` ones. Grep with context and verify each hit.

## What to remove

### A. The `food` + `rest` stop types

- `src/types/trip.ts` — `StopType` union → `'fuel' | 'overnight' | 'other'`.
- `src/lib/penny/tools/shared.ts` — `stopTypeSchema` z.enum.
- `src/lib/penny/tools/addStop.ts` — the `stop_type` enum (line ~123) **and** the tool `description` (line ~110, lists "fuel, food, overnight, rest, or other").
- `src/lib/penny/tools/updateStop.ts` — the `stop_type` enum (line ~54).
- `src/app/api/stops/route.ts` — `stopTypeEnum` (line ~15).
- `src/app/api/stops/[id]/route.ts` — `stopTypeEnum` (line ~13).
- `src/components/stops/StopCard.tsx` — `STOP_DISPLAY` is `Record<StopType, …>`; remove the `food` and `rest` entries (keep `fuel`, `overnight`, `other`). Removing them from `StopType` makes the extra keys a tsc error, so this is forced.
- `src/components/LegCard.tsx` — `formatStopType()` switch: remove the `case 'food'` and the **stop-type** `case 'rest'` (it returns `'Rest'`). This fn takes a `string`, so confirm you're not affecting leg rendering.
- `src/components/StopsSection.tsx` — `TYPE_ORDER` array.
- Penny system prompt (`src/lib/claude.ts`): scan `<route_vs_stop_decision>` / `<fuel_planning_rules>` / `<route_planning_rules>` for any "food"/"groceries"/"park"/"rest area" mentions and trim.

### B. The amenity finders behind them

- **Parks finder (`rest`):** delete `src/server/places/nearby-parks.ts` and `src/app/api/places/nearby-parks/route.ts`; remove the `nearbyParks` method from `src/lib/api.ts`; remove the `nearby-parks` pattern assertion in `src/lib/noExternalCallsGuard.test.ts`.
- **MoreStopsModal:** `src/components/stops/MoreStopsModal.tsx` is already a deprecated stub (`return null`) with a `groceries`/`parks`/`water` data shape — delete it + `MoreStopsModal.test.tsx` and any remaining import.
- **Check `nearby-stops`** (`src/app/api/places/nearby-stops/route.ts`, `server/places/nearby-stops.ts`, `api.ts nearbyStops`): figure out if anything live still calls it. Fuel planning uses Google Places directly via `server/fuel.ts`, NOT this — so `nearby-stops` is likely also dead amenity-finder surface. Remove only after confirming no live caller.

### C. Tests

- `src/components/stops/StopCard.test.tsx` — drop the `food`→`GROCERIES` and `rest`→`PARK` assertions.
- `src/components/stops/StopsSection.test.tsx` — the "renders type labels" test currently uses a `food` stop (id `…004`); switch it to a kept type (`other`) or just assert `FUEL`.
- File deletions: use the cowork delete-permission flow if `rm` returns "Operation not permitted".

### D. Database

`stops.stop_type` is a plain `text('stop_type')` column (NOT a pg enum) — **no migration needed** to remove enum values. Existing rows with `stop_type='food'|'rest'` would just be orphaned string values (harmless; optionally a one-off `UPDATE … SET stop_type='other'` data cleanup, but not required for the code change).

## Done when

- `StopType` is `'fuel' | 'overnight' | 'other'` (assuming Sam keeps overnight + other).
- No `stop_type`/`StopType` reference to `'food'` or `'rest'` remains anywhere (grep). The **`leg_type: 'rest'`** rest-day path is untouched and its tests still pass.
- The parks/groceries finders + MoreStopsModal are gone; no dangling imports.
- `tsc --noEmit` clean + `npm run test` pass (note: in the Linux sandbox `parseStartDate.test.ts` and `onboardingIntentScan.test.ts` fail to *load* on `server-only` — that's environmental, pre-existing, not caused by this work).
- CLAUDE.md updated: stop-type list, the `api/places/nearby-parks` route removed from API Routes, and a note under the MVP teardown section.

## Don't

- Don't touch the `rest` **leg type** (rest days).
- Don't remove `overnight`/`other` unless Sam confirms — they're trip-step machinery, not amenities.
- Don't re-touch dump-station (already removed).
