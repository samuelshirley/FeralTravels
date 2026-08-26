# ADR: Finn — the fuel-stop + pricing engine

> **Update 2026-07-22 — Google-only cutover.** Finn no longer uses OSM. Station
> search moved from OSM Overpass to **Google Places Text Search (New)**
> (search-along-route), and route geometry now comes from the leg's stored
> **Google Directions** polyline (the OSRM client was removed). **Fuel pricing
> was removed entirely** — no tankerkoenig, no Google `fuelOptions`, no price
> columns on `stops`. The ODbL-vs-Google-ToS rationale below is therefore
> historical: we now persist only the Google `place_id` (ToS-allowed) plus the
> coords/name of stops the user keeps. Everything about the *placement* engine
> (range math, tank state, greedy placer, `no_stations_found` safety warning)
> is unchanged. See `docs/plans/google-only-teardown.md`.

**Status:** Proposed
**Date:** 2026-06-26 (updated 2026-06-26: station eligibility filter built; live Google `fuelOptions` price fallback; tri-state price display)
**Deciders:** Sam
**Replaces (delete + rebuild):** the Google-Places fuel logic in `src/server/fuel.ts` / `fuelPlaces.ts` is **torn out** and rebuilt under a single new module, `src/lib/finn/`. This is a clean teardown, not an incremental migration — the old sampler accreted weird states partly because fuel logic was spread across Penny + server. Good *pure* logic (`fuelTankState.ts`) is **relocated into Finn, not deleted**.
**Source material:** `docs/fuel-stop-agent-brief.md` + the 2026-06-26 design conversation. Read the brief first; this doc resolves its five open questions and adds the engineering detail (selection algorithm, scoring, schema, phasing).
**Pairs with:** Penny's onboarding/Settings flow — Penny produces the single number Finn trusts (`range_km`); Finn never derives it.

---

## Context

Penny plans the trip and talks to the user. **Finn** owns one job: given a route and a vehicle, place fuel stops so the driver never runs past safe range, and rank them by price where we have price data. This is the product's headline feature; everything else exists to make it useful on the road.

The app today has a *working but legally and qualitatively limited* fuel planner (`src/server/fuel.ts`): it samples the route polyline every ~0.85×range km, calls **Google Places** Nearby Search at each sample, and persists the chosen Google stations (place_id, name, coords, `googleMapsUri`) into the `stops` table. Two problems with that as the foundation:

1. **It persists Google place data.** The brief's data-source rule — Google for live routing/render only, never stored — is correct, and the current planner violates it. Finn's OSM migration is also the fix for this.
2. **It has no price awareness at all.** The only `price` reference in `src/lib/penny/` is the `submitIdea` stub that logs fuel pricing as a *missing* capability.

Forces at play: legal (Google ToS forbids storing/deriving datasets from their places; OSM is ODbL and storable), cost (Places + price-feed calls are metered — hence lazy planning + caching), safety (overland routes run through empty country; never run dry), and data fragmentation (EU has good open price feeds; the US has none).

### Constraints (decided)

- **Regions:** Europe **and** US, same engine. EU gets price ranking; US ships **station-only, no price** at first (labelled honestly).
- **No LLM in the hot path or on the safety floor.** The common path (find/rank/place) and the hard gap-safety math are deterministic and reproducible. An **agentic supervisor** (LLM) wakes *only on exceptions* — empty/thin/conflicting data — to validate, re-query, and escalate. It may gather data and ask the user via Penny; it may never invent a station/coordinate/price or override the safety floor.
- **Reuse the seams, rebuild the guts.** Keep the *interface* surfaces — `POST /api/legs/[id]/fuel-stops`, the `planFuelStops` Penny tool, the `stops` table as cache, `vehicleProfile.ts` for the range number — but delete the old implementation behind them and rebuild it inside `src/lib/finn/`. `fuelTankState.ts` moves into Finn intact.

### Responsibility boundary — Penny vs Finn (load-bearing)

The single most important architectural line, and the fix for the "weird states":

- **Penny owns the conversation and produces a *perfect number*** — the validated fuel range (+ fuel type + tank state) — and then **gets out of fuel logic entirely**.
- **Finn owns *everything* downstream of that number** — stations, gap/safety math, pricing, ranking, caching, the exception supervisor. He **starts from a clean, trusted input** and never re-interprets free text or trip prose.

Previously Penny was doing both, so fuel state leaked across the chat boundary and drifted. After this split, the only thing crossing from Penny to Finn is structured, validated data — never "smart" free-text the way the lockdown invariants forbid.

---

## Decision

Build Finn as a **deterministic service** behind the existing endpoint + Penny tool, with three layers:

1. **Stations — OSM (Overpass).** Query `amenity=fuel` and `highway=services` within a tight buffer of the route polyline. Storable (ODbL + attribution), so it can live in the `stops` cache. **Replaces** the Google Places station lookup.
2. **Prices — regional providers behind one interface.** Per-station open feeds first: Tankerkönig (DE), then France (`prix-carburants`), Spain, Italy (Austria is rate-limited). Where no open feed covers a region, a **live Google `fuelOptions` provider** (non-stored — see below) supplies a price when Google has one; this is what gives the US (and no-feed EU stations) a price instead of nothing. Only when *no* provider covers a country at all does Finn report `unavailable_in_country`.
3. **Routing — Google, live only.** Directions for the polyline + map render. Never persisted.

Selection is a **reachability filter + scoring function** — arithmetic, not LLM judgement — wrapped by an **agentic supervisor** that engages only when the deterministic core returns something empty, thin, or suspicious (see "When the core fails" below). Finn the dog is the brand: the deterministic core is his reflexes, the supervisor is the part that feels like him thinking.

> **Why a deterministic core (not a fully agentic selector):** picking the optimal in-range station is a constrained optimization, not a language task. An LLM in the *hot path* would be slow, non-reproducible, costly per plan, and able to hallucinate a coordinate or price — the exact failure the lockdown invariant ("the LLM converts, it does not author") exists to prevent. **Crucially, the gap/safety math stays deterministic too:** the component answering "will I run dry across this stretch?" must never be the one that can hallucinate, because its failure mode strands a driver. The LLM adds value on *exceptions*, where its job is to fetch more data and escalate — never to author a fact or relax the floor.

---

## The selection algorithm

### 1. Anchor on distance, not ETA

Walk the route polyline by **distance** to find the refuel window. Google's ETA assumes the speed limit; a loaded overlander runs ~20–25% slower, so ETA-anchored planning drifts. Distance is speed-independent. (`split-route.ts` already walks polylines.) Use estimated *time* only for display and as a soft tiebreaker, with the speed correction applied.

### 1b. Eligibility filter — drop truck-only / private stations (BUILT)

Before any reachability or scoring math, drop stations a normal passenger / overland
vehicle can't or shouldn't use. A bare `amenity=fuel` corridor query returns unmanned
HGV diesel stations (e.g. "St1 Truck") in industrial lots — card-only, diesel-only, no
normal pumps. Routing a normal vehicle there is the "CarPlay sent me to a truckstop"
failure. **This is only possible on OSM** — Google Places has no truck type, which is one
more reason stations come from OSM, not Google.

Built as `src/lib/finn/stationFilter.ts` (pure, 13 unit tests). `classifyStation(tags)`
rejects on *positive evidence only* (safety bias — never drop on missing tags, since
excluding a usable station can strand a driver):

- **`access`** ∈ {private, no, permit, military, delivery, customers, employees} → `private_access`.
- **Name/brand** matches a word-boundary truck marker (`truck(s|stop|park)`, `lkw`, `camion`) → `truck_only`. Anchored so it catches "St1 Truck" but not the town "Truckee".
- **Fuel composition:** HGV diesel with no petrol, or diesel-with-petrol-explicitly-`no`, or `hgv=designated` with no petrol → `truck_only`. Stations that merely omit petrol tags are kept.

`filterUsableStations(stations)` partitions kept vs rejected (keeping the reason for the
debug endpoint). Runs on the OSM corridor result before everything below.

### 2. Reachability filter (hard guardrail)

Entering-tank state comes from `fuelTankState.ts` (continuous-drive model: only the trip-start full tank and *actual selected fuel stops* refill; rest days/overnights do **not**). Finn works with the **two numbers Penny already captures** (verified in code — migrations 0007/0011):

- `range_km` (**R**) — the vehicle's fuel range. Finn **never** routes past it. *(Single metric since 2026-08-25 — the old comfortable (C) / hard-max (H) pair and the C→H stretch zone are gone; migration 0025.)*

Both already reach Finn via `projectVehicle`. For a candidate at along-route distance `d` from the current fuel position (`B = kmBurnedSinceLastRefuel`):

```
safe       = (B + d) ≤ H        // hard constraint — never cross the absolute ceiling
inComfort  = (B + d) ≤ C        // soft preference — ideally stop by here
```

**Nothing past `R` is ever recommended** — that's the conservative bias, plus the `no_stations_found` honest-warning path for genuinely remote legs. The user's number is used as-is (no hidden haircut); the driver is told to state a range that already includes their reserve.

### 3. Comfort band (soft preference) — replaces the "450–500 / 1% margin" idea

> **Pushback, carried from the design chat:** a hard 450–505 km window with a 1% reserve is both brittle (if no station sits in that thin band you're stranded) and unnecessary (if you always fill to full, stopping at 60% vs 90% costs the *same* fuel — the only real cost of stopping early is *more stops*, i.e. time). Replace it with a soft band, not a hard window.

Prefer stops in the **upper part of the range** — default band ~**60–100% of `R`** consumed since last refuel — so the driver isn't refilling half-full and isn't cutting it fine. The band is a *scoring preference*, not a filter — but **never past `R`**. **"Fill once a day"** is a further soft nudge (most rigs at ~500 km/day need one fill), always subordinate to the `R` guardrail.

### 4. Scoring (the "two-part decision," made explicit)

For each reachable candidate compute a cost (lower = better):

```
score =  w_price     · priceNorm           // cheaper is better; 0 when price unknown
       + w_detour    · detourPenalty        // extra distance/time off the route
       + w_band      · bandDeviation        // distance from the ideal refuel point in the comfort band
       + w_brand     · brandPenalty         // optional: down-rank unwanted brands / wrong fuel type
```

- **`w_price` vs `w_detour` is the one user-facing knob** — "save money" vs "save time." Default balanced. This is what decides motorway-vs-supermarket.
- **Do not hardcode "motorway preferred."** Motorway service areas are systematically the *most expensive* fuel (often +10–30¢/L). Zero detour is a *real benefit* captured by `detourPenalty ≈ 0`, but a supermarket station 5 min off the ramp that's €12/tank cheaper should be allowed to win. The scoring function decides; the user's knob tilts it.
- **Detour is computed cheaply first, precisely only for finalists.** Use perpendicular distance from the polyline (free, from OSM coords) to rank, then do a real Directions detour call **only for the top N** candidates. Avoids one routing call per station.
- **Prefer a station we have a price for.** Among the reachable+eligible candidates, **priced stations rank above non-priced ones**, and the **cheapest priced** one wins (adjusted for detour via the worth-the-detour math, so a 30 km detour for 2¢ doesn't win). Worked example (Sam): 5 stations in the window, 3 priced / 2 not → pick the cheapest of the 3 priced. Implement as a strong "has-price" preference (priced set is chosen from first), not just the `w_price` magnitude term.
- **Non-priced is a last resort, never a disqualifier.** Finn falls to a non-priced station **only when no priced candidate is safely reachable** — so a driver is never stranded for lack of price data. In a country with no pricing source at all, every candidate is non-priced and selection cleanly degenerates to distance/detour, which is correct.

### 5. Output contract

```
FuelStopCandidate {
  placeId (OSM node/way id), name, lat, lng,
  distanceAlongRouteKm,
  detourMinutes | null,
  // Tri-state, NEVER a silent null (see "Price availability model" below):
  price: { state: 'priced', amount, currency, fuelType, asOf }
       | { state: 'unknown' }                            // country covered, this station has none
       | { state: 'unavailable_in_country', country },   // no pricing source for this country
  whyTag: 'cheapest_in_range' | 'on_route' | 'near_your_stop' | 'only_option',
  googleMapsUrl,            // single-destination link (see below)
  alternatives: [...]
}
```

Penny slices these into the per-day view and narrates the `whyTag`. **Google Maps link is single-destination per stop** — multi-stop URLs aren't reliable. (A whole-day directions URL with `waypoints=` up to 9 stops exists via `maps/dir/?api=1&...` if we want it later; not needed for v1's "navigate to this station" CTA.)

### Price availability model — never a silent null

`price` resolves to exactly one of three states; the UI shows a distinct, calm message
for each so a missing price never reads like a bug:

| State | When | Display |
|-------|------|---------|
| `priced` | a provider returned a price for this station + fuel type | the price + `as of {time}` |
| `unknown` | the country **is** covered (open feed or Google), but this station has no price | "price unknown" (per-stop) |
| `unavailable_in_country` | **no** provider covers this country at all | "price unavailable in {country}" (country-level) |

Rules:

- **Decide `unavailable_in_country` statically**, from a per-country capability map (`hasOpenFeed?` / `googleFuelOptionsLikelyCovered?`), *before* spending lookups. Don't probe every station to conclude a country has nothing. Per-stop `unknown` only happens *inside* covered countries.
- **Resolution order per station:** regional open feed → live Google `fuelOptions` → `unknown` (covered country) / `unavailable_in_country` (uncovered). Try every source we have before giving up.
- **Each stop needs its country attributed** (a trip crosses borders). Prefer OSM `addr:country`; else derive from coordinates. Cheap, but a real required field.
- **Reality check (the Nordics):** Norway/Sweden/Finland/Denmark have no per-station open feed and thin Google coverage, so the Sweden→Nordkapp test trip will largely show `unavailable_in_country` / `unknown`. That's correct, not a defect — the per-station data genuinely doesn't exist there. The price feature is really a DE/FR/ES/IT + Google-covered-US feature first.
- **Live Google `fuelOptions` is non-stored**, consistent with the legal backbone: fetched per view (a single Text Search (New) call with `fuelOptions` in the field mask returns the match + price together), displayed with `as of`, never persisted to the `stops` cache.

---

## The math modules (the deterministic core, in depth)

Finn is "really, really in-depth" precisely *here* — a set of small, pure, independently-testable math units. Each takes structured input and returns structured facts; none calls an LLM.

1. **Range / reachability** — `safe = (B + d) ≤ R`, where `R = range_km`, `B = kmBurnedSinceLastRefuel`. The number is used as-is.
2. **Burn / tank state** — *exists* (`fuelTankState.ts`): continuous-drive model, only the trip-start full tank and actual fuel stops refill.
3. **Gap math (safety)** — largest fuel-free stretch ahead vs reachable distance → the "fill now / carry N liters" alarm. Deterministic, never the LLM (see next section).
4. **Detour math** — perpendicular distance to the polyline (cheap, ranks everything) → real Directions detour distance+time for finalists only. Classifies on-motorway-services (≈0) vs off-ramp vs in-town.
5. **Worth-the-detour / cost trade-off** — the Germany/Norway resolver: `savings = (priceHere − priceThere) × litersToFill`; `detourCost = extraKm × fuelCostPerKm + timeValue`. Recommend the cheaper station only if `savings > detourCost + margin`. With real prices this is pure arithmetic — no guessing whether "the motorway is cheaper here."
6. **Pricing math** — normalize currency + unit (€/L vs $/gal), per fuel type, weight by price age (`priceAsOf`), reject outliers. Missing price → term drops out, rank on detour/band.
7. **Fuel-type compatibility** — match the vehicle's fuel (diesel / octane grade / LPG / AdBlue) against OSM `fuel:*` tags. **Needs a `fuel_type` field re-added to the vehicle profile** (removed in migration 0007 — owned by the Penny task). Without it Finn can't guarantee the station sells the right fuel.
8. **Comfort-band + fill-frequency scoring** — prefer refuel at ~60–90% of range used; soft "one fill per day." Both soft, always subordinate to the hard floor.
9. **Cost-to-fill / budget** — `litersNeeded × price` per stop → summed trip fuel-budget estimate. A near-free product feature once prices exist.
10. **GPS reconciliation** — expected remaining range (from plan) vs actual position/elapsed distance → drift detection → prompt the user to confirm/update tank state (they own the truth). Feeds module 1. (UI + the prompt-timing bug are in the Penny task.)
11. **Units / locale** — metric/imperial display, per-country currency.

## When the core fails — the agentic supervisor

The deterministic core handles the easy 95% (e.g. cheap fuel along a French motorway) and owns the hard safety math. But a pipeline that queries OSM, gets `null`, and shrugs is a *safety bug* — the Norway/Romania case: 300 km left in the tank, the next station is 500 km out, nothing reachable. Two things must happen, and they use opposite tools:

**A. Gap detection + alarm — deterministic, never the LLM.** Compute the largest fuel-free stretch ahead vs the tank's reachable distance. If `distanceToNextReachableFuel > maxReachableDistance`, raise a hard, structured alarm: *fill at the last station before the gap; carry ≈N liters; this stretch is X km with no fuel.* This is the one judgement that must never be probabilistic, because its failure mode is a stranded driver. It is also the backstop: **if the supervisor errors or times out, this alarm still fires.**

**B. Validation + recovery — the agentic supervisor (LLM).** It engages *only* on exception triggers and its mandate is to **gather data and escalate, never fabricate**.

| Trigger (deterministic detects) | Supervisor action |
|---|---|
| Empty reachable set | Re-query OSM wider buffer / alternate tags; cross-check a **live, unstored** Google lookup for a station OSM missed; search for fuel in a town just off-route |
| Only-option with thin margin | Verify it's real & open (hours/24h); confirm before relying on a single point of failure |
| Suspicious data | Outlier price; `amenity=fuel` that's actually a marina/aviation dock; stale `closed` tag — flag and down-weight or re-fetch |
| Large gap ahead | Hand Penny a structured question: *"500 km gap ahead, ~300 km in tank — carry jerrycans, or detour 20 km to Røros to fill?"* |

**Hard limits on the supervisor (preserves the lockdown invariant):** it may request more data (always re-validated by the deterministic core) or ask the user via Penny; it may **not** invent a station/coordinate/price, mark a leg safe against the gap math, or relax the safety floor. Cost/latency stay bounded because it fires only on the ~5% of hard legs — the France case never pays the LLM tax.

This **is** Finn: a deterministic core + an agentic supervisor + the Penny↔Finn escalation channel. The standalone "algorithmic gas-station API" is just the core called when no exception trips.

## Tank state, lazy planning, caching

Unchanged from the brief — reproduced here as the binding contract:

- **Full tank at trip start** is the one guaranteed refuel; Penny states it at onboarding's end. User can override (see Q4).
- **Cold-opened far day** (day 15 with days 1–14 unplanned) will often compute *out of range* — that's *correct*, since they'd run dry without earlier stops. Handle with honest copy ("plan your earlier days first"), **not** a red error, and **do not** cascade-plan upstream days (defeats lazy loading).
- **`stops` table is the cache** (`stop_type='fuel'`). Persistent across sessions.
- **Lazy:** explicit **"Find fuel stops"** button per day; today's day may auto-plan on load (one cheap lookup). Loading animation while searching.
- **Invalidation:** new per-leg `fuel_plan_hash` + `fuel_planned_at`. Hash = leg geometry (start/end/waypoints/polyline) + vehicle profile (range/reserve) + entry tank state + price-feed region/version + Finn algo version. Recompute only when the hash changes (route edit, waypoint swap, vehicle change).

---

## List view, cache tiers, and price refresh

**List view.** Days render relevant-first: today (e.g. June 26) at the top, future drive days below. Each day shows its skeleton immediately; fuel stops fill in per the load rules below.

**Two-tier cache — the key realization.** A fuel stop is two facts with very different lifetimes, so cache them separately:

1. **Station + placement** (which OSM station, where on the route, detour) — depends only on route geometry + the range number. Invalidated *only* by `fuel_plan_hash` (route/waypoint/vehicle change). Lives for weeks. Expensive (Overpass + detour).
2. **Price** at that station — time-sensitive but *cheap* to refresh. Stored on the fuel-stop row as `price` + `price_as_of`.

So Finn never re-runs the expensive corridor search just because prices aged. → **A separate, lightweight price-refresh path** (`POST /api/legs/[id]/fuel-stops/refresh-prices`) that walks the *existing* stops and re-queries only their prices. Pennies, not a full replan.

**Why a multi-day-old plan is still a good plan.** Price **dispersion is structural, not volatile** — the expensive station *sits* high and farms inattentive drivers; it isn't jittering against the cheap one. So the *relative ordering* of stations — what actually decides where Finn sends you — is stable over days. That's the licence to be cheap: we don't need minute-fresh data to pick the right station.

**Caveat (hold the line):** absolute prices *do* move, regionally a lot — German stations re-price several times a day on a known intraday cycle (Tankerkönig is real-time for this reason); Australia runs weekly cycles. Trust a few-days-old plan for *which station*; never *display* a stale absolute number as current. Always show `price_as_of`; refresh eagerly-but-cheaply.

**Freshness policy.**
- **Station placement:** valid until `fuel_plan_hash` changes.
- **Displayed price:** soft TTL ~24h; if a viewed/approaching day's prices are older, fire the cheap refresh.
- **Ranking:** tolerates ~3 days (structural dispersion); re-rank only if a refreshed price moved enough to change order.

**Getting today pre-loaded — and a scope flag.** You want today's drive day already populated on app open. Two ways:
- **Recommended, no new infra:** auto-load today's fuel stops on app/page open — the brief already allows this ("today's day may auto-plan on load; one cheap lookup"). Brief spinner on first open, then cached. Achieves the UX with zero cron.
- **Optional pre-warm (cron):** a midnight job refreshing *today's* (and maybe tomorrow's) drive-day prices so it's instant on open.

> **⚠️ Scope flag (per CLAUDE.md MVP discipline):** the MVP teardown explicitly **cut cron jobs / nightly replan**. A midnight pre-warm reintroduces a (narrow) cron. It is *not* required — auto-load-on-open gives ~the same experience. Recommend shipping cron-free for MVP and adding the pre-warm later only if open-latency actually bothers users. Flagged so it's a conscious choice, not scope creep.

## Resolving the brief's five open questions

1. **First region + feed →** Germany / **Tankerkönig** (free, real-time, official; the DE/EU test trip lives here). EU adapters follow on the same interface.
2. **US strategy →** OSM stations + **live Google `fuelOptions` as the price provider** (non-stored) where Google has coverage; `unavailable_in_country`/`unknown` otherwise. This *updates* the earlier "station-only, no price" call — `fuelOptions` gives the US a price without breaking the cache contract (price is live, never persisted). Revisit a paid feed (OPIS / commercial) only if `fuelOptions` US coverage proves too thin.
3. **Freshness-hash inputs →** as listed above. Invalidating leg edits: start/end change, waypoint add/remove/reorder, route re-fetch, vehicle range/reserve change. Vehicle *name* change does **not** invalidate.
4. **Starting fuel override →** capture **per-trip**, not per-vehicle (it varies by trip) and not onboarding-only. Add `trips.start_fuel_fraction` (default `1.0`). Onboarding states the full-tank assumption; the override edits this field.
5. **`planFuelStops` tool vs the lazy-button endpoint →** **converge on one core, keep two thin entrypoints.** Both the Penny tool and `POST /api/legs/[id]/fuel-stops` call the same deterministic `planFuelStopsForLeg` service. The tool is Penny's trigger/discussion path; the button is the UI's. No duplicated logic.

---

## Data-source split (the legal backbone)

| Source | Used for | Stored? | License/ToS |
|--------|----------|---------|-------------|
| Google Directions / Maps JS | live route polyline, map render, finalist detour calc | **Never** | ToS forbids persisting/deriving |
| Google Places `fuelOptions` | **live** price fallback where no open feed covers the region | **Never** (per-view fetch, shown with `as of`) | ToS forbids persisting; live enrichment is allowed |
| OSM Overpass (`amenity=fuel`, `highway=services`) | station identity, coords, brand, tags | **Yes** (the cache) | ODbL — storable with attribution |
| Regional open price feeds | per-station prices | **Yes** | Open gov data (per-feed terms) |

New clients: `src/lib/osm/` (Overpass) and `src/lib/fuelPricing/` (a `PriceProvider` interface + per-region adapters). **Display OSM attribution** wherever stored station data is shown (ODbL requirement).

---

## Where Finn lives — module, not a separate service or DB

Finn should be a **hard-walled module in the existing app and database**, not a separate deployable service and **not** a separate database.

- **One database (Neon).** Finn's inputs — route geometry, tank state, the range number, prior selected stops — already live here, and the `stops` table *is* his cache. A second DB turns every plan into a cross-database sync problem for zero current benefit. Any new fuel tables (OSM station cache, price snapshots) go in the same DB.
- **A module, not a microservice.** `src/lib/finn/` (or `src/lib/fuel/`) behind one clean interface, with `src/lib/osm/` and `src/lib/fuelPricing/` as its data adapters. A separate deployable service buys independent scaling Finn doesn't need pre-revenue and costs latency, inter-service auth, and ops. **Design the seam so Finn *could* be extracted later** — don't pay for it now.
- **The one real "service" concern is execution time, not topology.** Overpass + price-feed calls are slow and Vercel functions time out. Solve that by running planning as a **background job that writes the cache** (the "Find fuel stops" button kicks off async work + the UI polls), *not* by standing up a separate database or server.

Net: modular monolith now, clean interface, extractable later. Matches the "ship → make money → iterate" posture.

## Options considered

### Option A — Google Places for stations **and** prices (`fuelOptions`)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low (one vendor) |
| Cost | High (Enterprise+Atmosphere SKU for `fuelOptions`) |
| Legal | **Blocker** — can't persist → breaks the cache contract |
| Coverage | Global but opaque; prices "last known," possibly stale |

**Rejected as the *stations* source.** The caching/UX contract requires storing fuel stops; storing Google data violates ToS. **But adopted for *prices* in live, non-stored mode** — `fuelOptions` is the price fallback where no open feed covers the region (see Decision layer 2 + "Price availability model").

### Option B — OSM stations + regional open price feeds (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium (Overpass client + N price adapters) |
| Cost | Low (open data; Overpass free, self-hostable) |
| Legal | Clean (ODbL storable + open gov feeds) |
| Coverage | EU excellent; US station-only |

**Chosen.** Legally storable, cheap, and the price feeds are fresher and station-level. Cost is more adapters and dependence on OSM completeness.

### Option C — keep current Google-Places sampler, bolt price feeds on
**Rejected.** Leaves the ToS-persistence problem in place and keeps the cruder "sample every X km" search instead of a corridor query.

---

## Consequences

**Easier:** legally clean stored data; price ranking becomes possible; one tunable knob (price-vs-time) instead of a brittle hardcoded window; reproducible plan facts; cheaper steady-state (open data + cache).

**Harder / to watch:**
- **OSM completeness & freshness** — a closed/missing station is a real failure mode. Keep the existing radius-escalation + `no_stations_found` honest warning; consider a Google *live* cross-check (not stored) for the finalist only.
- **Overpass reliability/rate limits** — plan for a hosted/cached Overpass or a provider with SLA before scale.
- **Price-feed staleness** — always surface `priceAsOf`; never present a stale price as current.
- **Detour cost** — cheap perpendicular-distance prefilter is essential; precise Directions detour only for finalists.
- **Teardown blast radius** — deleting the Google-Places fuel guts means auditing every reader of fuel `stops` that assumes a Google `place_id`/`googleMapsUri` (the UI's "open in Maps" link, dedupe-by-place_id in the old planner, any admin view). OSM ids are a different namespace; the single-destination Maps link is rebuilt from lat/lng, not a Google place_id.

**Revisit later:** US paid price source; whole-day multi-waypoint Maps links; fuel-type/brand preferences in the vehicle profile.

---

## Build plan (phased)

**Phase 0 — Teardown + new engine (no prices yet)**

*Delete:* the Google-Places guts of `src/server/fuel.ts`, all of `src/server/fuelPlaces.ts` (Google adapter), the Google-place persistence into `stops` (place_id/`googleMapsUri` as Google IDs), and the related Google-specific tests.
*Relocate (keep) into `src/lib/finn/`:* `fuelTankState.ts` (pure tank math, already correct), the conservative-bias / `no_stations_found` warning semantics, the radius-escalation idea (re-expressed as OSM buffer widening).
*Keep untouched:* the seams — `POST /api/legs/[id]/fuel-stops`, the `planFuelStops` tool (rewired to call Finn), `vehicleProfile.ts`.

1. Create `src/lib/finn/` as the home for all fuel logic; move the keepers in.
2. `src/lib/osm/` Overpass client: corridor query around the polyline (`amenity=fuel`, `highway=services`), bounded buffer, buffer-widening fallback.
3. Reachability filter + comfort-band scoring (price term off). Perpendicular-distance prefilter; finalist detour via live Directions (never stored).
   - **3b. Station eligibility filter — DONE** (`src/lib/finn/stationFilter.ts`, 13 tests): drop truck-only / private stations from the OSM corridor before placement.
4. Schema: add `legs.fuel_plan_hash`, `legs.fuel_planned_at`, `trips.start_fuel_fraction`; reconcile the double-reserve in `computeEffectiveRangeKm`. (`schema.ts` → `db:generate` → `db:migrate`; update CLAUDE.md schema/table notes.)
5. Background-job execution for the slow Overpass/Directions work + cache freshness check + invalidation on leg/vehicle edits.

**Phase 1 — EU pricing (Germany)**
6. `src/lib/fuelPricing/` `PriceProvider` interface + Tankerkönig adapter (free key).
7. Overlay prices on in-range candidates; enable `w_price`; `cheapest_in_range` whyTag; show `priceAsOf` + OSM/feed attribution.

**Phase 1.5 — Agentic supervisor (exception handling)**
7a. Deterministic gap detector + alarm (largest fuel-free stretch vs reachable distance) — wire as a backstop independent of the LLM.
7b. Exception triggers from the core (empty set, thin margin, suspicious data, gap) → supervisor that re-queries OSM/live-Google, validates, and escalates a structured question to Penny. Hard limits enforced (no fabrication, no floor override). Time-out falls back to the deterministic alarm.

**Phase 2 — EU breadth**
8. Austria (E-Control), France (`prix-carburants`), Spain, Italy adapters behind the same interface. Region→provider resolver from station country.

**Phase 3 — US**
9. Station-only path: OSM stations, price provider returns "unavailable," UI labels it. Revisit paid feed separately.

**Cross-cutting**
10. UI: per-day "Find fuel stops" button + loading state; honest copy for out-of-range cold-opens and no-price regions.
11. Penny copy: never invent prices/stations; log unsupported asks via `submitIdea`.
12. Tests: `fuelTankState` already covered; add OSM corridor parsing, reachability/scoring unit tests, price-adapter contract tests, and an e2e for the button → ranked list. Run `npm run test` + `tsc --noEmit` after every change.

---

## Action items

1. [x] `src/lib/osm/` Overpass corridor client (`buildFuelCorridorQuery`/`parseOverpassFuel`/`fetchFuelCorridor`) — built, tested.
2. [x] `src/lib/finn/` math core: range (`range.ts`), route projection (`route.ts`), tank state (re-export), **station eligibility filter (`stationFilter.ts`)**.
3. [ ] **Phase 0 cutover (active):** pure greedy multi-stop planner in `src/lib/finn/`; rewire `planFuelStopsForLeg` to OSM+Finn behind the existing seam; **delete `fuelPlaces.ts` + the Google station path** so there is exactly one planner.
4. [ ] Verify no remaining reads of Google `place_id`/`googleMapsUri` assume Google identity after the OSM swap (UI "open in Maps" link rebuilt from lat/lng).
5. [ ] Schema migration: `fuel_plan_hash`, `fuel_planned_at`, `start_fuel_fraction`.
6. [x] Phase 1: `src/lib/fuelPricing/` (tri-state coverage + coordinator), Tankerkönig (DE) + Google `fuelOptions` providers, wired into `planFuelStopsForLeg` (bulk pricing → cheapest-priced preference; finalist tri-state persisted on `stops`, migration 0016), `StopCard` display, `vehicles.fuel_type` (default diesel). Tests in `lib/fuelPricing/*`.
7. [ ] Phase 2: FR/ES/IT feed adapters (same interface; add to `FEED_COUNTRIES`); fuel-type onboarding question + Settings select; cheap price-refresh path; `fuel_plan_hash`/`start_fuel_fraction`.
