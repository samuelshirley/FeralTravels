# Overnight stop + fuel engine — feature scope

Status: scoping complete, not yet built. Captures decisions from a planning conversation on 2026-05-29.

## Problem

Penny suggests overnight parking spots that don't work — e.g. a nice dog park with no actual parking lot. The app has no data on what makes a *good* place to park for the night (like park4night / iOverlander). We want to fill that gap, cheaply, without an LLM in the decision path and without a giant pre-built catalogue.

## Core decisions

**1. On-demand, not catalogued.** Don't pre-scan all of Europe. When a route is planned, search for overnight + fuel candidates only inside the relevant window of *that* route, right then. Cache results by place/OSM id, so the catalogue self-populates as a byproduct of real route planning — biased toward roads people actually drive.

**2. Hybrid data sources — this is also the legal answer.**
- **Google** = live routing / Directions / map render only. Never persisted.
- **OSM (Overpass)** = everything we store: parking lots, fuel stations, surface, motorhome/overnight tags. ODbL-licensed, free, ours to keep and redistribute (with attribution).
- The legal risk with Google was never copyright (facts aren't copyrightable) — it's the API *contract* (ToS forbids storing imagery / building derived datasets, penalty = key revocation = app outage). Keeping all stored data OSM-derived sidesteps it entirely.

**3. Deterministic, no LLM in the decision.** Route anchoring, corridor search, and ranking are pure geometry + vector queries. Penny only extracts intent ("~6h toward Innsbruck") and presents the result. The chosen stop is a plan fact from a deterministic engine, consistent with "Penny is a wrapper only."

**4. Anchor on distance, not time.** Google's ETA assumes the speed limit. Real overlander speed is lower (test driver does 90–100 km/h in a Hilux at 11 L/100km drafting semis → a 6h Google estimate came out to 7.5h, ~25% long). Distance is speed-independent. Anchor the day's reach on km, inferred from actual GPS progress over the trip (~500 km/day observed), refined by a per-vehicle motorway-speed value.

**5. Target a window, not a point.** Accept a range (e.g. 5.5–7h equivalent, or ±X km) plus ~15 min off-route tolerance. "15 minutes out of the way doesn't matter over a 500km day."

## The overnight-stop engine (deterministic core)

1. Have the route polyline from Google Directions (already fetched — zero extra cost).
2. Walk the polyline to the anchor distance (daily-km preference, bounded by fuel range). `split-route.ts` already does this kind of thing.
3. Define an acceptance window: polyline segment around the anchor + a small off-route buffer.
4. Query candidates inside the window via OSM/Overpass: `amenity=parking` (with surface, capacity), `tourism=caravan_site`, `leisure=park`-with-parking. This directly fixes the no-parking-lot failure — `amenity=parking` means a real lot exists, no imagery needed.
5. Rank deterministically: detour from route, proximity to anchor, lot quality (surface gravel/unpaved, size, `motorhome=yes`/`overnight=yes`).
6. Snap the day's final route point to the best candidate. Surface top 1–3.

## Fuel

- **Fill once a day** is the default planning convenience (few vehicles need 2 fills/day at ~500km). But it's a *soft preference layered on a hard guardrail*: never route past safe fuel range, never assume an implicit refuel (rest/overnight don't refill the tank). Keep the conservative bias — a loaded climb into Innsbruck burns more than cruise-control flat.
- **Only two station options, both zero-detour:** (a) motorway service areas (`highway=services` in OSM — on the motorway, not a detour), and (b) a fuel station immediately adjacent to the chosen overnight spot. Nothing out of the way.
- **Cheapest-in-range:** corridor query — OSM `amenity=fuel` within a tight buffer of the polyline (only ~25 stations passed in a real 7.5h day, so it's bounded), then overlay prices from free national open feeds: Germany MTS-K, Austria E-Control Spritpreisrechner, France prix-carburants open data, Spain & Italy equivalents. Rank by price. Google never touches this.

## UX / performance

- Paginate the route build. Render the itinerary list immediately from cheap deterministic data (legs, dates, route). Compute the overnight point lazily — loading spinner when the user opens that day.
- Cache the computed overnight result per leg so the spinner only shows once; pre-warm in the background after the list paints.

## New data points

- **Per-vehicle motorway speed.** Add to `vehicle-setup` onboarding, default ~110 km/h. Lives on the vehicle (fuel-range math is already vehicle-keyed; both the ETA correction and the consumption curve read from there). Existing vehicles get the default.
- **Daily-km reach.** Inferred from GPS progress, not a manual setting.

## Deferred (v2+)

- **Mountain-pass / elevation awareness.** OSM tags `mountain_pass=yes`; elevation profile available from open DEM data. Would sharpen time + fuel estimates. Hold until distance-anchoring proves insufficient on real drives — it's a second-order correction.
- **Satellite/CV van-detection — second layer, not just a tiebreaker.** Local Gemma vision model on a VPS, run only on the top few candidates per night. Two jobs OSM can't do:
  1. **Surface informal spots OSM can't see.** The best spots are often a random residential/edge street where vanlifers cluster — invisible to vector data because nothing tags an ordinary street as "good van parking." Imagery is the only cheap way to find this whole class of spot.
  2. **Confirm tolerance.** A cluster of *camper vans, especially with roof solar panels*, in a single snapshot is a strong signal: it self-selects for our exact use case (overlanders, not commuters), the Poisson logic means a one-off image catching 3 implies a high base rate, and vans don't repeatedly gather where they get ticketed — so clustering is itself a legality/tolerance proxy. This partly closes the "imagery can't see legality" gap.
  - **Make-or-break unknown: resolution.** Before building any CV pipeline, run a 20-min manual test — can a human eye reliably distinguish a camper-van-with-solar from a car at the available zoom for these streets? If the human can't, Gemma can't. Test before building.
  - Imagery caveats still apply: stale (1–3 yrs), daytime snapshot. And don't store Google's imagery — analyze and keep only the derived label ("spot X had 3 solar vans on 2024-06"), or use a licensed imagery source.

## Calibration spots (ground truth from the test trip)

Real spots to tune the ranking against, graded by the driver.

| Spot | Grade | Why |
| --- | --- | --- |
| Brunau Allmend, Zürich (big nature area, gravel lots, paid meter) | GOOD | Large lot, quiet, has a dog park as a bonus |
| Parc d'activités Canine, 8 Prom. Jacques Brel, 69520 Grigny-sur-Rhône (Plus Code JQ4G+5R), nr Lyon | GOOD | Nice lot, empty dog park, quiet residential, open 24h. **Not on park4night.** Sits beside a large commercial/industrial lot off Prom. Jacques Brel. |
| Dog park near Bogenfest, Innsbruck (Penny's suggestion) | BAD | Nice dog park but **no parking lot at all** |

**Emerging discriminator:** it's not "park vs dog park" — it's *"is there a real adjacent parking lot."* Both good spots are green space + a lot; the bad one is green space + no lot. `amenity=parking` next to `leisure=park`/`leisure=dog_park` in OSM captures this directly.

**Validates the thesis:** the Lyon spot is good and *not on park4night*. Reusing community DBs alone won't cover the spots we find — the OSM-lot-near-greenspace heuristic surfaces ones the crowdsourced apps miss.

## Suggested first build slice

1. OSM/Overpass client lib (new `src/lib/osm/`).
2. Deterministic distance-anchoring function: route polyline + daily-km + fuel range → acceptance window.
3. Corridor candidate query + ranking.
4. Wrap as a Penny tool (`planOvernightStop`) and/or replan-engine hook for auto "stop for the night."
5. Add per-vehicle motorway speed to onboarding + schema.
