# Fuel-stop + pricing agent — concept brief

> **For a fresh task.** This is the self-contained spec for the dedicated fuel-stop-finding + pricing agent. It is **out of scope** for the MVP teardown task (which only strips dead features and fixes the date bug). Build this on top of the small, clean MVP. Source material: distilled from `docs/overnight-stop-feature-scope.md` (the fuel section there was fully reasoned) + the 2026-06-26 MVP-scoping conversation.

## What this agent owns

One job, two halves:

1. **Find gas stations along the route**, placed so the driver never runs past safe fuel range.
2. **Rank them by "the right price"** — cheapest-in-range, using regional open price feeds.

This is *the* headline feature of the product. The rest of the app (day-by-day plan, distance, progress anchor, Penny chat) exists to make this useful on the road. The app today has **zero** fuel-price data — the only `price` reference in `src/lib/penny/` is the `submitIdea` stub that logs fuel pricing as a *missing* capability. So this agent builds the capability from nothing.

## The seam — how it plugs in

The MVP exposes the interface; this agent implements the guts behind it. Do **not** re-architect the app — fill in these existing surfaces:

- **`POST /api/legs/[id]/fuel-stops`** — the endpoint the UI calls. Input: a leg. Output: a ranked list of fuel-stop candidates for that leg.
- **`planFuelStops` Penny tool** (`src/lib/penny/tools/`) — Penny's path to trigger/discuss fuel stops.
- **`stops` table** (`src/server/repos/stops.ts`) — fuel stops are persisted here as `stop_type='fuel'` rows. This **is** the cache (see below).
- **`src/lib/penny/fuelTankState.ts`** — pure continuous-drive tank math. The hard dependency (see below). DB shim: `src/server/fuel.ts`.
- **`src/lib/vehicleProfile.ts`** — vehicle range/fuel-consumption math; fuel-range is vehicle-keyed.

## Tank-state model — the hard part

Fuel need is sequential, and this is the easiest thing to get wrong:

- **Full tank at trip start.** This is the single guaranteed refuel assumption. Penny states it explicitly at the end of onboarding ("I'm assuming you start with a full tank"). The user can override with a different starting level.
- **No implicit refuels.** Rest days and overnight stops do **not** refill the tank. Only an *actual selected fuel stop* (or the trip-start full tank) counts as a refuel — this is already how `fuelTankState.ts` works; keep it.
- **Therefore tank state entering leg N depends on which fuel stops were selected in legs 1…N-1.** When the user jumps ahead and opens a far-out day whose upstream days aren't planned, run the continuous-burn math from the trip-start full tank through *only the stops planned so far*. A cold-opened day-15 will often compute as "out of range" — that's correct (they *would* run dry without earlier stops). **Handle it with honest copy** ("plan your earlier days first"), not a red error. Do **not** cascade-plan all upstream days (rejected: defeats lazy loading).
- Keep the conservative bias: never route past safe range, never assume a refuel that didn't happen. A loaded climb burns more than flat cruise.

## Lazy planning + caching — the UX contract

Decided in the MVP-scoping conversation. The skeleton (legs, dates, routes, distances) is built eagerly and cheaply. The expensive per-stop search is deferred:

- **Lazy-load on opening a day** (no explicit button). Clicking into a day triggers the fuel-stop search if that day isn't already cached. Avoids burning Places/price API calls on a leg 20 days out that will move before they drive it.
- **Loading animation** on the stops section while the search runs.
- **Cache in the `stops` table** with a timestamp (`fuel_planned_at`) = persistent, survives reloads/sessions. Don't re-search while the cache is fresh.
- **Price re-validation, not re-search, when stale.** Stations rarely move, but prices change. If a day's cache is older than ~24h (or it's the current day), don't redo the full search — make a separate, cheap price-only check that confirms/refreshes the price for the already-found stations ("I have the stations; just validate the price is still right"). Keeps API spend minimal. The exact TTL and the shape of the price check are for this task to design.
- **Freshness / invalidation:** a per-leg marker (e.g. `fuel_plan_hash` + `fuel_planned_at`), hash = leg geometry (start/end/waypoints/polyline) + vehicle profile + entry tank state. Auto-invalidate when the user edits the leg's route, swaps waypoints, or changes the vehicle. (Small schema add — owned by this task.)

## Finding stations — deterministic engine

No LLM in the decision path. Penny only extracts intent and presents results; the chosen stops are deterministic plan facts.

- **Anchor on distance, not Google ETA.** Google's ETA assumes the speed limit; real overlander speed is ~20-25% slower (a Hilux at 90-100 km/h drafting semis turned a 6h Google estimate into 7.5h). Distance is speed-independent. Walk the route polyline (`split-route.ts` already does polyline walking) to the fuel-range bound.
- **Corridor query, bounded.** OSM `amenity=fuel` within a tight buffer of the polyline. In a real 7.5h day only ~25 stations qualified, so it's bounded. Prefer zero-detour options: motorway service areas (`highway=services`) and stations adjacent to the day's end point.
- **Fill once a day** is the default convenience (few vehicles need two fills at ~500 km/day) — but it's a *soft preference over the hard range guardrail*, never the other way round.

## Price data — the research task

"The right price" means overlaying prices on the in-range candidates and ranking cheapest-first. Price data is **regional and fragmented** — this is the main research work of the task:

- **Germany:** MTS-K / Tankerkönig — free, real-time, official. (You'll likely start here — the test trip is in DE/EU.)
- **Austria:** E-Control Spritpreisrechner.
- **France:** prix-carburants open data.
- **Spain / Italy:** national equivalents exist.
- **EU generally:** good open-feed coverage.
- **US:** **no** official feed. GasBuddy has no real public API; commercial APIs are paid/limited. Treat US pricing as a separate, later problem — for the US, "stations on route within range" may ship without price ranking at first.

Decide a regional fallback ladder: real price feed where available → no-price station list elsewhere, clearly labelled.

## Data-source split — also the legal answer

- **Google** = live routing / Directions / map render only. **Never persisted.** ToS forbids storing imagery / building derived datasets (penalty = key revocation = outage).
- **OSM (Overpass)** = everything stored (stations, tags). ODbL-licensed, free to keep and redistribute with attribution. Facts aren't copyrightable; the risk was always the API contract, and keeping stored data OSM-derived sidesteps it.
- New OSM client probably lives at `src/lib/osm/` (the overnight scope proposed the same).

## Honesty rules

- Penny must **never invent prices or stations.** The `submitIdea` pattern exists precisely so Penny logs an unsupported request instead of faking a capability. Until a region has real price data, Penny says so rather than guessing.
- Results are deterministic plan facts; Penny presents, never fabricates.

## Open questions to resolve in the task

1. First region + price feed to integrate (recommend Germany/Tankerkönig).
2. US strategy: ship station-only (no price) first, or block US until a price source exists?
3. Exact freshness-hash inputs and the leg-edit events that invalidate the cache.
4. How starting fuel-level override is captured (vehicle setup vs onboarding vs per-trip).
5. Whether `planFuelStops` (action) and the lazy day-open trigger converge or stay separate.

## Explicitly out of scope for this agent

Overnight-stop finding, dump stations, route building, the day-by-day planner, progress tracking — those are either MVP-core (already built) or deliberately deferred. This agent is **fuel stops + price ranking only**.
