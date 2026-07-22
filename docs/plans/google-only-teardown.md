# Teardown plan: all-Google data sources, no OSM, no fuel pricing

**Date:** 2026-07-22
**Context:** FeralTravels is now a portfolio/interview piece, not a launch candidate. The
public Overpass instance (station search) rate-limits a single trip load, and the public
OSRM demo (corridor geometry) is the next limit waiting to happen. Decision: keep the app
behaving exactly as it does today — auto fuel-stop planning included — but source
everything from the Google Maps APIs already in use, and delete fuel *pricing* outright.

**What stays:** Finn's auto fuel-stop planner (range math, tank state, `declare_fuel_state`,
lazy cache, no-stations safety warning), Penny, trips/legs/stops, Google directions for leg
routing (already the case).

**What goes:** Overpass client, OSRM client, the entire pricing layer (tankerkoenig +
Google fuelOptions + coordinator), the data-source health/alert/rate-limit machinery that
existed to babysit the free public instances, and the admin "Fuel data sources" page.

---

## Phase 0 — decisions locked in

1. **Station source → Google Places Text Search (New), search-along-route.**
   One POST to `https://places.googleapis.com/v1/places:searchText` with
   `searchAlongRouteParameters.polyline.encodedPolyline`, `textQuery: "gas station"`,
   `includedType: "gas_station"`. Google's docs allow any valid encoded polyline — it does
   not have to come from the Routes API — so the leg's stored geometry works as-is.
   One call per leg plan replaces the Overpass corridor query.

2. **Corridor geometry → the leg's stored Google polyline. OSRM dies entirely.**
   `fuel.ts` currently re-fetches the route from OSRM just to project stations onto it.
   The leg already has full road-following geometry in `legs.geometry` (built from Google
   Directions steps by `src/lib/google/directions.ts`). Read it from the DB instead:
   zero extra network calls, and the fuel plan is guaranteed to match the drawn route
   (today OSRM and Google can disagree). Fallback if a leg has no geometry: call
   `@/lib/google/directions` (the Google one), never OSRM.

3. **Pricing → deleted.** The planner already degrades gracefully when no price providers
   are configured (`pricePerLitre: null` → distance-based selection). Deleting pricing
   makes that the only path. Remove the tri-state price columns from `stops` and the
   price UI from `StopCard`.

4. **Truck-stop filter → keep, adapted.** `stationFilter.ts` exists because OSM tags catch
   truck-only stations (the "CarPlay sent me to a truckstop" failure). Google loses the
   `access=*` / `fuel:*` tag signals — accepted regression — but keeps two of the three
   defenses: the `TRUCK_NAME_RE` name/brand regex works on Google names unchanged, and
   Places (New) has a `truck_stop` place type, so drop any result whose `types` contains
   `truck_stop` without containing `gas_station`. Keep the safety bias: reject only on
   positive evidence.

5. **`stops.source` value 'osm' → 'google'.** The auto-planner marks its rows
   `source='osm'` and `autoPlannerOptionSql` + the selected-stop preservation logic key on
   it. Rename the marker and migrate existing rows (`UPDATE stops SET source='google'
   WHERE source='osm'`). Touchpoints: `src/types/trip.ts`, `src/server/fuel.ts`,
   `src/app/api/stops/route.ts`, `src/app/api/stops/[id]/route.ts`,
   `src/lib/penny/tools/{addStop,updateStop,shared}.ts`.

---

## Phase 1 — build the Google station source (app still fully working)

- **New:** `src/lib/google/places.ts` — `searchFuelAlongRoute(encodedPolyline, opts)`.
  - Field mask kept to Pro-tier fields only: `places.id`, `places.displayName`,
    `places.location`, `places.types`, `places.googleMapsUri`,
    `places.businessStatus`. (Pro SKU = 5,000 free calls/month under the March-2025
    per-SKU free tiers; with the existing `FUEL_CACHE_TTL_MS` lazy cache that is far more
    than a demo app uses. Do NOT request Enterprise-tier fields like `currentOpeningHours`
    — that triples the SKU cost for nothing.)
  - Filter out `businessStatus !== 'OPERATIONAL'`.
  - Return a source-agnostic `FuelStation` type: `{ id: placeId, lat, lng, name, brand:
    null, types, googleMapsUri }`.
  - Unit tests with canned JSON fixtures (mirror `overpass.test.ts` structure).
- **Adapt:** `src/lib/finn/stationFilter.ts` — retype from `OsmFuelStation` to the new
  `FuelStation`; keep `TRUCK_NAME_RE`; replace tag checks with the `truck_stop`-type
  check; delete `PRIVATE_ACCESS` / `fuel:*` logic. Update `stationFilter.test.ts`.
- **Keep untouched:** `src/lib/finn/{plan,range,route}.ts` — pure math, source-agnostic
  already (`route.ts` is projection geometry, not OSRM).

## Phase 2 — rewire `src/server/fuel.ts`

- Step 3 (OSRM fetch, ~line 258): replace with reading `legs.geometry` for the leg
  (LineString coords → `LatLng[]`; note GeoJSON is [lng, lat]). Fallback to
  `@/lib/google/directions` `getDirections`. Delete the OSRM import.
- Step 4 (Overpass corridor): replace `fetchFuelCorridor` with
  `searchFuelAlongRoute(encodePolyline(polyline))`. Keep the existing failLeg /
  empty-candidates / `no_stations_found` semantics and the retry wording (update the
  "OSM station service" copy).
- Step 4b and 5b (bulk + finalist pricing): **delete both blocks**, plus
  `NO_PRICE_COUNTRIES`, `priceColumns()`, and the pricing imports.
  `PlacementCandidate.pricePerLitre` can be deleted from `plan.ts` too (then the planner
  is purely distance/comfort — simplify `plan.test.ts` accordingly).
- Stops insert: `source: 'google'`, real `placeId`, `googleMapsUri` from the place
  (fall back to `mapsCoordUrl`), drop the `...priceColumns(...)` spread.

## Phase 3 — deletions (each bullet = one reviewable commit)

- **OSM/OSRM:** `src/lib/osm/` (both files), `src/lib/directions.ts`,
  `src/app/api/directions/route.ts` (verified: zero frontend consumers).
- **Pricing:** `src/lib/fuelPricing/` (whole dir, 8 files + tests),
  `src/server/fuelPricingProviders.ts`, price display in
  `src/components/stops/StopCard.tsx` (`priceLine` + props), price fields in
  `src/types/trip.ts`, `TANKERKOENIG_API_KEY` handling.
- **Babysitting machinery:** `src/server/dataSourceHealth.ts`,
  `src/server/dataSourceAlerts.ts`, `src/lib/dataSourceRateLimit.ts` (+ tests),
  `src/app/admin/data-sources/page.tsx`, its link on `src/app/admin/page.tsx`, and the
  osrm/overpass branches in `src/app/api/debug/fuel/route.ts` (keep the debug route if it
  still earns its keep for Places debugging; otherwise delete).
- **Review-and-trim:** `src/lib/fuelPlanErrorSemantics.ts` (drop rate-limit-specific
  branches), `src/lib/fuelCache.ts` (keep — still the thing protecting the Google quota),
  `docs/design/finn-fuel-agent.md` (rewrite the data-source section; the ODbL/ToS
  rationale is now inverted — see Caveats).
- **Schema migration (one migration file):**
  - `stops`: drop `price_state`, `price_per_litre`, `price_currency`, `price_as_of`,
    `price_country`.
  - `stops`: `UPDATE ... SET source='google' WHERE source='osm'`.
  - Keep `vehicles.fuel_type` (user data, harmless, still shown on the vehicle chip) and
    all tank-state / `declare_fuel_state` columns (behavior kept).
- **Env:** remove `OSRM_ENDPOINT`, `OVERPASS_ENDPOINT`, `TANKERKOENIG_API_KEY` from
  `.env.example` and from Vercel env. Confirm **Places API (New)** is enabled for
  `GOOGLE_MAPS_SERVER_API_KEY` in the Google Cloud console (it's a separate toggle from
  the legacy Places API; Directions/Geocoding already work so billing is on).

## Phase 4 — verify

1. `npx vitest run` — green, including the new places + adapted stationFilter tests.
2. Grep gate: `grep -rn "osrm\|overpass\|tankerkoenig\|fuelPricing" src/` returns nothing.
3. E2E (`npx playwright test`) — the fuel-stop flows in `e2e/` still pass.
4. Manual: load the trip that triggered the original rate limit; confirm stops appear,
   no price line, `fuelStatus='ready'`, and Google Cloud console shows Text Search Pro
   calls in single digits (cache working).
5. Deploy preview → promote per the usual tested-preview pipeline.

## Caveats — read before starting

- **Google ToS vs the stops cache.** OSM was chosen originally *because* Google forbids
  persisting most Places data (the comment atop `overpass.ts`). Storing `place_id` is
  explicitly allowed indefinitely; lat/lng and names have a 30-day caching window under
  the ToS. Stops a user adds to their itinerary are a defensible gray area, and for a
  portfolio app the practical risk is near zero — but don't demo this to a Google
  recruiter as "and we cache their data forever." If it ever matters: store only
  `place_id` + refresh details on read.
- **Filter regression.** OSM `access=private` fleet pumps can no longer be detected;
  a card-only depot with an innocent name will slip through. Known, accepted.
- **Interview story.** This teardown is itself good interview material: "chose ODbL data
  to own it, hit fair-use limits, weighed self-hosting a 400 GB Overpass box vs. a
  source swap, chose the swap and deleted 2,000+ lines" is a strong systems-tradeoff
  narrative. Keep the git history clean (per-phase commits) so it's showable.

**Estimated diff:** ~30 files deleted / ~12 modified / 1 added, plus one migration.
Phases 1–2 first (app working at every commit), then deletions, then the migration last.
