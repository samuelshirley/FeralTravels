# Height-Aware Routing (future / deferred)

**Status:** Deferred. Not currently scheduled. This document captures the full design conversation so a future implementer (probably future-Sam) can pick it up cold.

**Last updated:** 2026-04-22.

---

## Why this is deferred

Sam's own prioritization call, and it's the right one:

- **Low frequency.** Most overlanding miles are on motorways. US interstates are federally mandated to 16'0" minimum clearance (with a handful of grandfathered 14'0" spots), so a tall van basically can't hit a bridge on a motorway.
- **Users self-select.** Anyone with a tall vehicle knows they have a tall vehicle. They avoid city centers and old Italian towns by habit.
- **The near-miss is a last-mile problem.** Approaches to off-road trails, detours to freshwater stops, campground ingress — secondary and rural roads where almost every actual bridge strike happens. Real, but infrequent.

Conclusion: high-severity, low-frequency. Ship the rest of the app first.

That framing matters because it also tells you what the feature needs to be *when* it ships: a pre-flight warning system for secondary-road segments, not a motorway routing change. Don't over-engineer.

---

## The problem Sam actually hit

While testing the app (April 2026), Sam was in a ~8'6" van. Google Maps kept trying to route him under a bridge he couldn't fit under. He saw the warning signs in time, found a left turn, rerouted manually. Classic tall-vehicle near-miss on a secondary road.

The goal of this feature is: *when Sam is in a vehicle with a known height, don't let him drive into a bridge.* That's the whole thing.

---

## The big misconception to fix up front

Penny today hands off navigation with a URL like
`https://www.google.com/maps/dir/?...&dir_action=navigate`. The moment that URL opens in Google Maps on the phone, **Google's routing engine takes over.** Google Maps consumer routing does not accept vehicle height, weight, width, or axle count — verified against [Routes API docs, April 2026](https://developers.google.com/maps/documentation/routes/vehicles) — and will happily put you under a 7'10" bridge in your 8'6" van.

So nothing Penny does server-side, by itself, will stop Google from routing you under a bridge while you're driving. Any solution has to address **either** the planning step (what Penny shows you pre-flight) **or** the on-device nav step (what the phone does during the drive), and ideally both.

This constraint shapes all the options below.

---

## Option matrix: server-side routing engines

| Engine | Height | Weight | Length | Width | Axles | Free tier | Paid rate | Data quality |
|---|---|---|---|---|---|---|---|---|
| **Google Routes API** (consumer) | — | — | — | — | — | 10K/mo essentials | $5/1K | N/A (no truck mode) |
| **HERE Routing API v8** (truck mode) | ✓ | ✓ | ✓ | ✓ | ✓ + cargo/tunnel | 30K/mo | $0.75/1K | Industry-best; proprietary truck attrs |
| **Mapbox Directions** (`max_*` on driving) | ✓ | ✓ | — | ✓ | — | 100K/mo | $2/1K | "Coverage may vary by region" — hybrid OSM+commercial |
| **TomTom Routing API** (truck) | ✓ | ✓ | ✓ | ✓ | ✓ + ADR/tunnel | 2.5K/day | tiered | Strong EU, decent US |
| **Self-hosted OSRM** (truck Lua profile) | ✓ (OSM `maxheight`) | ✓ (OSM `maxweight`) | ✓ | ✓ | via Lua | unlimited | ~$20/mo VPS (region) | **Spotty** — only as good as OSM tags |
| **Self-hosted Valhalla** | same | same | ✓ | ✓ | ✓ | unlimited | ~$20/mo VPS | same OSM caveats |

Key notes:

- **Google Routes API has no truck parameters.** The "Trucking" phrase in some Google marketing refers to a gated enterprise product (Routes API Advanced for Logistics), not something we can turn on via API key.
- **Mapbox added `max_height`, `max_width`, `max_weight`** to the driving profiles (newer than early 2025). Three parameters only — no length, no axles. Docs caveat: "Coverage for road height restriction may vary by region."
- **OSM-based routers look tempting because free.** Wrong answer for a safety-of-life feature. OSM's `maxheight` coverage in the US is patchy — the specific low bridge on a county road that will kill your van probably isn't tagged. Use OSM as *supplemental* signal, not primary gate.

---

## Five approach shapes

### A. Advisory warnings (cheap, ~1 day)

Keep Google as routing engine. Before the user starts the leg, ask HERE (or Mapbox) the same from/to with truck constraints. Compare polylines. If they diverge materially, surface a warning on the leg card:

> ⚠ HERE Maps truck routing diverges from this Google route near [lat,lng]. Possible low clearance.

Additionally: decode Google's polyline, hit Overpass API for `maxheight` nodes within ~50m of the polyline, flag any `maxheight < vehicle.height_cm`.

**Pros:** No behavior change to trip UX. Low integration risk. Free tiers cover a solo user forever.
**Cons:** Pre-flight only. Google may still reroute mid-drive.
**Bridge saved?** Probably, if you read the warning before leaving. Maybe not, if Google reroutes during the drive.

### B. Truck-aware primary routing (2–3 days)

Replace Penny's routing call with HERE truck mode when vehicle has a height. Leg polyline, distance, duration reflect truck route. "Open in Google Maps" link still goes to Google — but stops and sequence are truck-safe.

**Pros:** Trip plan itself is truck-safe. Fuel-stop math more accurate.
**Cons:** Still no live truck awareness during the drive.

### C. Swap the phone nav app (behavior change, ~half day of code)

User setting: "Navigation app — Google Maps / Apple Maps / OsmAnd / CoPilot Truck / Waze." When vehicle height set, recommend a truck-aware app. Emit right URL scheme for each:

- **OsmAnd** (free + IAP) — `osmand.navigation:q=...`, open-source, truck profile supports height/weight.
- **CoPilot Truck** ($75 one-time or sub) — `copilot://mydestination?...`, full truck routing.
- **Google Maps** (default) — current behavior.
- **Apple Maps** — no truck routing.
- **Waze** — crowdsourced bridge alerts, no enforced truck routing.

**Pros:** Only option that reroutes around a bridge *during* the drive.
**Cons:** Requires user to install & configure different nav app. Many won't. URL-scheme support uneven.

### D. Self-hosted OSRM truck profile (1–2 weeks)

Run OSRM on VPS with truck Lua profile. Weekly OSM extracts.

**Pros:** Free. No vendor lock-in.
**Cons:** **Data isn't good enough.** We'd claim truck-aware routing while silently missing untagged bridges. Wrong responsibility level for a solo weekend-trip app. Don't.

### E. Waypoint-stuffing: force Google to match HERE's truck route (4–6 days — THE INTERESTING ONE)

This is the approach Sam specifically asked about. Keeps Google Maps as the on-device nav (his preferred choice for traffic + familiarity) while bounding Google's routing decisions to a truck-safe corridor.

**The mechanism.** Google Maps URL API takes `&waypoints=lat,lng|lat,lng|...`. Every waypoint is a required stop or via-point — Google routes *between* them, but if enough shaping waypoints are on the truck-safe path, Google has no room to divert under a bridge.

**Important:** GPX import to Google for navigation does NOT exist. You can import GPX to My Maps for visual display, but there's no URL scheme, intent, or API that tells Google Maps "follow this exact polyline in turn-by-turn." Sam's initial framing assumed this was possible — it isn't. Waypoint-stuffing is the near-substitute.

**Algorithm.**

1. Call HERE Routing v8 with `transportMode=truck` and vehicle height → truck polyline.
2. Call Google Directions (server-side API) or OSRM for the same A→B → car polyline.
3. Simplify both with Ramer-Douglas-Peucker (ε ≈ 50m) to reduce noise.
4. Sliding-window Fréchet distance to find divergence bands — segments where the two polylines are >100m apart for >200m of path.
5. For each divergence, rank by severity: `severity = (bridge_avoided ? 1 : 0.1) * divergence_length_km`. Bridge-avoidance divergences (confirmed via Overpass `maxheight` lookup) rank far higher than traffic-heuristic divergences.
6. Take top-N. For each, pick a pinning waypoint at the midpoint of HERE's version of that segment.
7. Stuff into `buildNavUrl`'s existing `waypoints` array.

**The hard ceiling: consumer Google Maps caps at 9 waypoints (origin + destination + ~7 shaping points).** Long legs with many divergences need ranking — pick the 7 most safety-critical. Typical near-miss is 1–2 bridges on a leg, not 20 — mostly fine.

**The thing to test before building anything:** does Google obey via-waypoints when it reroutes due to traffic? If yes, waypoint-stuffing is bulletproof for live reroutes. If Google drops via-waypoints on reroute, E is dead and we fall back to A + C.

I believe via-waypoints are required (not suggested) and preserved across reroutes, but I'm not 100% sure. Real on-road test required before writing code. See resumption checklist.

**Integration surface.**

- `src/lib/maps.ts` already has `buildNavUrl({ coords, waypoints })`. No change to that signature.
- New: `src/lib/truck-routing.ts` — thin HERE Routing v8 client. Env var `HERE_API_KEY`.
- New: `src/lib/route-diff.ts` — polyline simplify + divergence detection + waypoint ranking.
- Integration point: wherever legs are computed server-side (`src/server/routes.ts` / route generation). When `vehicle.height_cm` is set, run HERE in parallel, diff, emit shaping waypoints alongside existing route data. Pass through to client and into `buildLegDirectionsUrl`.
- Overpass client: `src/lib/overpass.ts`. Cache aggressively (bridge maxheight tags change rarely).
- Schema: likely a `route_warnings` JSON column on legs (or a `leg_warnings` table) for advisory copy.

**Cost estimate (rough):**

- HERE client + polyline decoder: ~1 day.
- Diff + divergence ranking: ~1–2 days (the algorithmic meat).
- Waypoint integration: <1 day (pipe already there).
- Overpass maxheight scan + caching: ~1 day.
- UX: warning card + "Google Maps is missing 3 shaping waypoints due to the 7-waypoint cap" copy + admin toggle: ~1 day.

Total: **4–6 days single focused dev.**

---

## Recommendation when this is eventually picked up

**A + E together.** Skip B (if waypoint-stuffing works, truck-aware primary routing is redundant). Skip D (OSM data quality unacceptable). Keep C on the table as a "power user setting" for anyone who wants CoPilot Truck or OsmAnd on the phone — orthogonal.

Phase 1: Pre-flight warnings (A) — ship advisory first, before any Google handoff changes. Catches obvious cases without touching nav handoff.

Phase 2: Waypoint-stuffing (E) — only after manual experiment (see below) confirms Google obeys via-waypoints on reroute.

Phase 3: Nav-app setting (C) — power-user flag, defaults to Google.

---

## Resumption checklist (do these first when you pick this up)

In strict order:

1. **Run the manual experiment.** Pick a real near-miss — a location you remember Google trying to route you under a bridge. In a browser, construct:
   ```
   https://www.google.com/maps/dir/?api=1
     &origin=<from-lat>,<from-lng>
     &destination=<to-lat>,<to-lng>
     &waypoints=<lat-lng-right-before-the-bridge>|<lat-lng-on-the-detour>
     &travelmode=driving
     &dir_action=navigate
   ```
   Open on phone. Drive (or simulate with Google Maps "route preview"). Watch:
   - Does Google follow the pins?
   - Simulate traffic slowdown (or find a real one). Does Google keep the pins on reroute, or drop them?

   **If yes to both:** waypoint-stuffing is viable. Proceed to step 2.
   **If Google drops pins on reroute:** E is dead. Fall back to A (pre-flight warnings) + C (nav-app setting).

2. **Sign up for HERE developer account, get API key.** Add `HERE_API_KEY` to `.env` and Vercel env vars. [HERE dev signup](https://platform.here.com/sign-up) — 30K free transactions/month.

3. **Check if `vehicle_type` or `length_m` columns need to come back.** Dropped from onboarding in commit `d7179b3`. If the feature wants more constraints (length for ferry pricing, axle count for bridge tonnage), add back to onboarding first. Height alone is sufficient for the bridge case.

4. **Build `src/lib/truck-routing.ts` first, test in isolation** with a few known tall-vehicle routes (Boston Storrow Drive is the classic). Validate HERE's output against a known-bad Google route before building anything else.

5. **Then `src/lib/route-diff.ts` with unit tests.** Where most of the bugs will live.

6. **Integration + UX last.** Don't over-commit to UX copy before the algorithmic core is known to work.

---

## Open questions for future-Sam

1. What's the actual height of your vehicle? This doc assumed ~8'6"/2.6m. If taller, more secondary routes become off-limits.
2. How often are you leaving the app mid-trip and using Google Maps ad-hoc? That frequency decides whether E protects you for the 90% case or only the 30% case.
3. Willing to pay $75 for CoPilot Truck as the "real" in-car answer, with Penny's role as pre-flight planner + destination handoff? If yes, C might be simpler long-term than E.
4. Want the UI to let you manually override — e.g. accept a low-clearance warning if the bridge is 9' and you're 8'6" and you trust the sign? Auto-refusing to route at all is a bad UX.

---

## Risks / honest caveats

- **HERE's truck data is good but not perfect.** Missing bridges happen. Overpass + HERE is better than HERE alone.
- **Free tiers rot.** HERE changed theirs in 2019; Google blew up theirs in 2018. Wrap vendors thin.
- **Vehicle height needs to actually be right.** If a user types 2.3 thinking meters but it gets stored as 2.3 cm, routing is worse than no routing. Onboarding now uses meters with 0.5–5.0 bounds (commit `d7179b3`) — good. Any new read of `height_cm` should sanity-check the range.
- **Not every low-bridge is routable around.** Some have no high-clearance detour within 30 miles. Warning copy needs to say "no detour available — plan to backtrack."
- **Google reroute behavior is the single biggest unknown.** The manual test in step 1 of the resumption checklist is the go/no-go gate for option E.

---

## Related code surfaces (as of 2026-04-22)

- `src/lib/maps.ts` — Google Maps URL shaping. `buildNavUrl` already accepts `waypoints`. This is the handle for option E.
- `src/server/onboarding.ts` — vehicle onboarding flow, persists `height_cm` (meters in UI, cm in DB).
- `src/components/VehicleProfileSection.tsx` — vehicle settings UI, height edited in meters.
- `src/lib/penny/context.ts` — `PennyVehicle` interface includes `height_cm`. Still includes `vehicle_type` and `length_m` for backward compat even though onboarding doesn't ask.
- Schema: `vehicles.height_cm` (integer, cm). `stops`, `routes`, `chat_history` tables — see `drizzle/` for current schema.

## Sources

- [HERE Routing API v8 truck routing docs](https://www.here.com/docs/bundle/routing-api-developer-guide-v8/page/concepts/truck-routing.html)
- [Mapbox Directions API — max_height/max_width/max_weight](https://docs.mapbox.com/api/navigation/directions/)
- [Google Routes API vehicle types (no truck mode)](https://developers.google.com/maps/documentation/routes/vehicles)
- [HERE pricing — 30K/mo free Routing](https://developer.here.com/pricing)
- [Mapbox pricing — 100K/mo free Directions](https://www.mapbox.com/pricing)
