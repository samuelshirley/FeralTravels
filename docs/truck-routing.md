# Tall-Vehicle Routing: Options

**Context.** Sam (6'4" van, ~8'6" roof?) hit the obvious overlanding problem: Google Maps happily routed him under a low bridge. He saw the signs, bailed, and rerouted manually. Penny should help prevent this class of near-miss.

This doc lays out the real options, the constraints each can and can't enforce, and a recommendation. It also pushes back on a mental model I think is wrong: **nothing Penny does server-side will stop Google from routing you under a bridge while you're driving.** More on that below.

---

## The core misconception to fix first

Penny today hands off navigation with a URL like
`https://www.google.com/maps/dir/?...&dir_action=navigate`. The moment that URL opens in Google Maps on your phone, **Google's routing engine takes over.** Google Maps consumer routing does not accept vehicle height, weight, width, or axle count — verified against [Routes API docs, April 2026](https://developers.google.com/maps/documentation/routes/vehicles) — and will happily put you under an 8'0" bridge in your 8'6" van.

So even if Penny computes a truck-aware route server-side and shows it in the UI, if the final tap is "Open in Google Maps," Google may pick a different path during the drive. Any truck-aware solution has to address **either** the planning step **or** the on-device nav step, and ideally both.

Concretely, we have two distinct problems:

1. **Planning:** When Penny shows a route preview, distance, and duration, should those reflect truck constraints?
2. **Driving:** When you're actually on the road, the app in your hand needs to know about your vehicle dimensions or you're back to Google's bridge roulette.

Solutions for (1) are all server-side API swaps. Solutions for (2) are either a different nav app on the phone, or a pre-flight warning list you read before leaving.

---

## Option matrix (server-side routing engines)

| Engine | Height | Weight | Length | Width | Axles | Free tier | Paid rate | Data quality |
|---|---|---|---|---|---|---|---|---|
| **Google Routes API** (consumer) | — | — | — | — | — | 10K/mo essentials | $5/1K | N/A (no truck mode) |
| **HERE Routing API v8** (truck mode) | ✓ | ✓ | ✓ | ✓ | ✓ + cargo/tunnel | 30K/mo | $0.75/1K | Industry-best; proprietary truck attrs |
| **Mapbox Directions** (`max_*` on driving) | ✓ | ✓ | — | ✓ | — | 100K/mo | $2/1K | "Coverage may vary by region" — hybrid OSM+commercial |
| **TomTom Routing API** (truck) | ✓ | ✓ | ✓ | ✓ | ✓ + ADR/tunnel | 2.5K/day | tiered | Strong in EU, decent US |
| **Self-hosted OSRM** (truck Lua profile) | ✓ (OSM `maxheight`) | ✓ (OSM `maxweight`) | ✓ | ✓ | via Lua | unlimited | ~$20/mo VPS (region) | **Spotty** — only as good as OSM tags |
| **Self-hosted Valhalla** | same | same | ✓ | ✓ | ✓ | unlimited | ~$20/mo VPS | same OSM caveats |

Notes:

- **Google Routes API has no truck parameters.** The "Trucking" phrase that occasionally shows up in Google marketing material refers to a gated enterprise product (Routes API Advanced for Logistics), not something we can turn on via API key. Confirmed April 2026.
- **Mapbox added `max_height`, `max_width`, `max_weight` to the driving profiles.** This is newer than my training knowledge — it's real and live. But only three parameters, no length, no axles. And their own docs caveat: *"Coverage for road height restriction may vary by region."* Translation: they use OSM-derived data in places.
- **OSM-based routers (OSRM/Valhalla/GraphHopper) look tempting because they're free.** They're also the wrong answer for a safety-of-life feature. OSM's `maxheight` tag coverage in the US is patchy; Storrow Drive in Boston is well-tagged because it's infamous, but the random low rail bridge on a county road in West Texas probably isn't. Use OSM as a *supplemental* signal, not the primary gate.

---

## The four approach shapes

### A. Advisory only (cheap, 1 day)

Keep Google as the routing engine. Before the user clicks "go," ask HERE (or Mapbox) *the same from/to* with truck constraints. Compare the two polylines. If they diverge, surface a warning on the leg card:

> ⚠ HERE Maps truck routing diverges from this Google route near [lat,lng]. Consider checking for a low bridge.

Also add a pre-flight scan: decode Google's polyline, hit Overpass API for `maxheight` nodes within 50m of the polyline, and list any that are < vehicle height.

- **Pros:** No behavior change to the trip UX. Low integration risk. One new server module. Free tiers cover a solo user forever.
- **Cons:** You still click "open in Google Maps" and Google may pick a different route during the drive. The warning is pre-flight only, not live.
- **Bridge saved?** Probably yes, if you read the warning before leaving. No, if Google re-routes mid-drive due to traffic.

### B. Truck-aware primary routing (2–3 days)

Replace Penny's routing call with HERE truck mode whenever the trip's vehicle has a height. The leg polyline, distance, and duration all reflect the truck route. The "Open in Google Maps" link still goes to Google (because that's what the phone knows how to open), but the *stops and sequence* you're navigating through are the truck-safe ones.

- **Pros:** The trip plan itself is truck-safe. If the user follows the in-app waypoint list, they're on HERE's truck route even if the connecting segments are Google's.
- **Cons:** Still no live truck awareness. If Google reshuffles the middle of a leg due to a closure, you could drift onto a non-truck road. Also: HERE and Google sometimes disagree on distance enough (~5–15%) that the fuel-stop math would need to use HERE's distances to stay accurate.
- **Integration surface:** Add `src/lib/truck-routing.ts` with a `routeForVehicle({ from, to, vehicle })` returning `{ polyline, distanceKm, durationMin, warnings }`. Call it from wherever legs are currently being computed (probably `src/server/routes.ts` or similar). `src/lib/maps.ts` stays as-is — it's only URL shaping.

### C. Swap the phone nav app (behavior change, not a code task)

Add a user setting: "Navigation app — Google Maps / Apple Maps / **OsmAnd (truck mode)** / **Organic Maps** / **CoPilot Truck** / **Waze**." When vehicle height is set, default to a truck-aware app. Emit the right URL scheme for each:

- **OsmAnd** (free + IAP for truck features) — `osmand.navigation:q=...` deep link, open-source, supports height/weight in its truck profile.
- **CoPilot Truck** ($75 one-time or sub) — URL scheme `copilot://mydestination?type=LOCATION&action=GOTO&...`, full truck routing with height/weight/axle.
- **Google Maps** (default) — current behavior.
- **Apple Maps** — no truck routing, same problem as Google.
- **Waze** — crowdsourced bridge alerts but no enforced truck routing.

This is the **only option that actually reroutes you around a bridge while driving.** Penny's role is just: emit the right URL.

- **Pros:** Fixes the real problem. The on-device app does continuous truck-aware routing.
- **Cons:** Requires the user to install and configure a different nav app. Not every user will. URL-scheme support is uneven — OsmAnd's is good; Trucker Path has basically none; CoPilot's works but requires the paid version.

### D. Self-hosted OSRM truck profile (1–2 weeks)

Run OSRM on a small VPS with a truck Lua profile filtering on `maxheight`/`maxweight`. Generate OSM extracts weekly. Penny calls this for truck routing.

- **Pros:** Free forever. No vendor lock-in. Same engine you'd use for fuel-range math, so one routing dependency.
- **Cons:** **The data isn't good enough for this job.** OSM bridge tagging is inconsistent; we'd be claiming "truck-aware routing" while silently missing bridges that just aren't tagged. For a solo weekend-trip app, this is the wrong level of responsibility. Use OSRM for distance matrices, not for bridge avoidance.

---

## Recommendation

**Do A + C.** Skip B for now; revisit if A's warnings turn out to be noisy or frequently wrong.

**Phase 1 — Advisory warnings (A):** ~1 day of work.

1. Add `src/lib/truck-routing.ts` with a thin HERE Routing v8 client. Environment variable `HERE_API_KEY`.
2. On leg creation/refresh, if `vehicle.height_cm` is set, fire a HERE truck-route request in parallel with whatever routing we do today. Compare polylines with a cheap Fréchet-distance heuristic (or just: do the two routes share most waypoints?).
3. If they materially diverge, persist a `warning` on the leg: `"HERE suggests a different path near [mile X] — possible low clearance"`.
4. Additionally query Overpass for `node[maxheight](bbox_around_polyline)` and flag any `maxheight < vehicle.height_cm`.
5. Render warnings on the leg card with a "learn more" link.
6. Don't change `buildLegDirectionsUrl` — the Google URL still goes to Google. The warnings are UI only.

**Phase 2 — Truck-aware nav app setting (C):** ~half a day.

1. Add `user_settings.preferred_nav_app` enum: `google` | `apple` | `osmand` | `copilot`.
2. In `src/lib/maps.ts`, split `buildLegDirectionsUrl` into per-app builders. Keep Google as the default. Add OsmAnd and CoPilot builders behind the setting.
3. In the vehicle onboarding flow, if the user sets a `height_cm`, show a one-time tip: "Google Maps doesn't route around low bridges. We recommend OsmAnd (free) or CoPilot Truck ($75) on your phone for the actual drive."
4. Surface it in Settings too.

**Phase 3 (only if needed) — Replace primary routing with HERE (B):** 2–3 days. Trigger condition: Phase 1 shows HERE and Google disagree on > 10% of legs for a height-set vehicle. Then the warnings are noisy enough that swapping the primary routing is justified.

## Why not HERE as primary routing today?

Because the user's **actual driving app is still Google**, which can re-route during the drive. Making the planner 100% truck-safe without fixing the on-device side buys us "distance and duration are 3% more accurate" — not "Sam doesn't hit the bridge." The on-device app is the safety net; the planner is the advisory.

## Risks / honest caveats

- **HERE's truck data is good but not perfect.** Missing bridges happen. The Overpass fallback catches some of HERE's misses; Waze user reports catch some of Overpass's misses. No single source is complete.
- **Free tiers rot.** HERE changed theirs in 2019; Google blew up their free tier in 2018; Mapbox has been stable but not immortal. If we bake a vendor into the primary path, we want a wrapper thin enough to swap out in a week.
- **Vehicle height needs to actually be right.** If a user types "2.3" thinking meters but it gets stored as 2.3 cm, the routing is worse than no routing. The onboarding now uses meters with 0.5–5.0 bounds (commit `d7179b3`) — good, but worth a server-side sanity check anywhere we read `height_cm`.
- **Not every low-bridge incident is routable around.** Some bridges have no high-clearance detour within 30 miles. The warning copy needs to make this clear ("low clearance ahead — there may not be a detour").

## Open questions for Sam

1. What height exactly is your van? This doc assumed ~8'6"/2.6m. If taller, some secondary routes become off-limits that weren't the problem.
2. How often do you leave trip planning and just open Google Maps ad-hoc during the drive? That frequency changes whether Phase 2 (swap the nav app) matters more than Phase 1 (pre-flight warnings).
3. Are you open to paying $75 for CoPilot Truck as the "real" in-car answer, and treating Penny's role as pre-flight planner + destination handoff?
