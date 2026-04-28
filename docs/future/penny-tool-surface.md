# Penny's Tool Surface (future / planned)

**Status:** Sketched, not scheduled. Design captured here so when we pick a tool to add, we already know what shape it should take.

**Last updated:** 2026-04-28.

---

## The framing: "agentic Penny" vs. tool-using Penny

Original instinct (Sam, April 2026): "Penny should be agentic — she should figure things out and prove them herself, not just be an API call to Anthropic."

Right instinct, but the word "agentic" was doing too much work. Two distinct ideas were getting bundled:

1. **Penny can call functions** — query Google Maps for a real route, look up weather along the leg, search for hotels. This is "tool use," not "agentic." It is the thing that solves ~80% of why Penny feels dumb today (she hallucinates distances and fabricates hotels).

2. **Penny runs a multi-step planning/reflection loop** — decomposes goals, second-guesses outputs, recursively refines. This is "agentic" in the literature sense. It is genuinely more powerful for ambitious tasks ("plan a 3-week European tour with these constraints") but costs 5–10x latency, 5–10x API spend per request, and has compounding failure modes where a hallucination in step 3 corrupts steps 4–10.

For a road-trip app where the most common request is "plan tomorrow's drive," the first is essential and the second is overkill until proven otherwise.

**This doc is about #1.** The agent loop is a small section at the bottom, gated on a real use case.

---

## What tools Penny needs

The principle: every fact Penny might hallucinate should come from a tool, not from her training data. Penny's job is to translate user intent into actions; the *facts* that drive those actions should come from APIs.

In rough priority order:

### 1. `get_route` — Google Directions / HERE / Mapbox

The single most important tool. Today Penny estimates distance and drive time from training memory ("Berlin to Prague is roughly 350km, ~3.5h"). She is wrong often enough to ruin trips. A real routing call gives ground-truth `distance_km` and `drive_time_minutes`, plus a polyline we can use elsewhere (overnight stop placement, fuel-stop interpolation, the future height-aware feature).

Inputs: origin, destination, vehicle profile (eventually).
Output: distance, duration, polyline, plus warnings (toll, ferry, border).

**Replaces:** Penny's hallucinated `distance_km` and `drive_time_minutes` on every `add_leg`.

**Cost:** $5/1K Directions (Google) after free tier; HERE 30K/mo free.

**Note:** This pairs naturally with the domain-rule validator. Once we have a real `drive_time_minutes`, the "≤ max_drive_hours_per_day" check has something honest to validate against.

### 2. `geocode` — convert place names to lat/lng

Penny currently emits `start_lat`/`start_lng` in `add_leg` actions and these are ~50% accurate (the right city, but the wrong specific point — usually city centroid when the user meant a specific neighborhood, sometimes just wrong). A geocoding call removes the guesswork.

Inputs: free-text place name, optional bias center.
Output: ranked candidates with lat/lng + canonical name.

**Replaces:** Penny's hallucinated coordinates everywhere. Also unblocks "I want to start from the campsite I bookmarked" by accepting partial names.

### 3. `search_overnight_stops` — places to sleep

Today Penny emits `add_stop` with `stop_type: "overnight"` and `source: "penny"` so the user knows to verify. The UI compensates by showing "🐕 Dog parks nearby" / "🌳 Parks nearby" Google Maps chips. This is a graceful workaround but Penny is still inventing names.

A real search (Google Places, OSM Overpass, or Park4Night-style data) returns genuine candidates. Penny's job becomes "rank and present" instead of "fabricate plausibly."

Inputs: lat/lng + radius, vehicle constraints (height for low-clearance lots, length for fitting), preference (free/paid/wild).
Output: candidates with name, coords, type, source URL.

### 4. `get_weather` — for the leg's date and route

Sam asks "is it going to rain on day 3" today and Penny shrugs because she doesn't know what day it is, where day 3 is, or what the forecast says. A weather tool unlocks weather-aware suggestions ("plan an indoor stop in Lyon — it's raining all day").

Inputs: lat/lng (or polyline-sampled), date.
Output: forecast summary, precipitation, temp range, wind warnings.

**Free option:** Open-Meteo (no key, no rate limit for sane use).

### 5. `search_fuel_stations` — replace `plan_fuel_stops`'s placeholder math

Current `plan_fuel_stops` interpolates fuel stops along a straight line between leg endpoints, named "Refuel near km N" with `source: "penny"`. The math is OK but the stops are placeholders. A real search call (Google Places type=`gas_station`, or OSM `amenity=fuel`) gives actual stations.

Pair with vehicle's `fuel_type` to filter (diesel-only, LPG, premium).

Inputs: lat/lng, radius, fuel type.
Output: stations with name, brand, address, coords.

### 6. `search_pois` — generic point-of-interest

Catch-all for "find me a coffee stop on the leg" / "any dog parks near tonight's camp" / "what's near here." Distinct from #3 (overnight) and #5 (fuel) because the discovery flow is different — POIs are usually mid-leg, optional, and the user will pick from a few.

Inputs: lat/lng, query string or category, radius.
Output: ranked candidates.

### 7. `get_border_crossing_info` — visa / paperwork / hours

Long shot. Schengen makes most of EU trivial, but the moment you cross to UK / non-EU Balkans / Morocco, real questions appear. A tool that hits a structured source (or a curated DB we maintain) turns Penny's vague "you'll need a passport" into "Croatia → Bosnia: passport, vehicle V5, third-party insurance green card. Border at Doljani is 24h, Klek is 06:00–22:00."

Lower priority — every user hits this maybe 1-2 times per trip.

---

## Why this list and not others

Things deliberately *not* on the list:

- **Real-time traffic.** Google Maps does this on the phone after handoff. We don't need it server-side and re-checking before handoff would just confuse users when our number drifts from Maps' number.
- **Booking integration (Booking.com, Hipcamp, etc.).** Different problem — tool use for *information* is one thing; tool use that *spends user money* is another. Out of scope for "make Penny stop hallucinating." If we ever add it, it goes through an explicit confirmation step, not a Penny tool call.
- **Train / flight search.** This is a road trip planner. Resist scope creep.

---

## Design notes for when we wire these up

- **All tools should be Anthropic-native tools** (`tool_use` blocks), not text-prompted "pretend to call this function" patterns. After the migration in [`docs/proposals/tool-use-migration.md`](../proposals/tool-use-migration.md), this is just adding entries to the tools array.
- **Cache aggressively.** Routes between two specific lat/lngs don't change minute-to-minute. Geocoding is even more cacheable. Cache key: tuple of inputs. TTL: routes 24h, geocoding 30 days, weather 1h, POIs 12h.
- **Validate tool *outputs* server-side too.** A tool returning malformed data shouldn't crash a Penny turn. Wrap each tool in a Zod parser; on parse failure, return `is_error: true` to Claude with a useful message, same as we do for input validation failures.
- **Cost guardrails per tool.** We already have a daily $-cap on Anthropic spend (`route.ts:27`). Each external API needs its own cap. Don't let a runaway loop spend $50 on Google Directions in an hour.
- **Stub all tools first with deterministic fixtures** for tests. Then point at real APIs behind a feature flag. Don't need both wired up to ship the migration.

---

## The speculative section: multi-step agent loop

This is the "agentic Penny" idea. Filing it here because it's worth keeping in view but it's not next.

**When it would actually be useful:**

- "Plan me a 2-week loop in the Alps with these constraints" — needs decomposition.
- "Find me a route that avoids tolls and includes 3 spa towns and respects my 6h/day rule" — multi-constraint satisfaction; one shot won't do it.
- "Re-plan everything because I'm a day behind schedule" — needs to reason over the whole plan, not just the next leg.

**When it isn't useful:**

- "Plan tomorrow's drive." — single-shot is faster and cheaper.
- "Add a fuel stop." — same.

**The right shape if we ever build it:**

A planner LLM call (cheap model, e.g. Haiku) that decomposes the request into N sub-goals → for each sub-goal, a regular Penny turn (Sonnet + tools) → an aggregator that stitches results and resolves conflicts. Each step is a separate API call with its own validation; failures don't cascade. The user sees a single response but it's backed by maybe 5–10 sub-calls.

**Cost / latency budget:** if a regular Penny turn is ~3s and ~$0.01, an agent loop is ~30s and ~$0.10. Worth it for the ambitious-trip case; bad for everyday tweaks. So if we build it, it's gated behind a different button ("Plan whole trip") or a different intent classifier upstream.

**Resumption checklist if we pick this up:**

1. First, make sure the regular Penny turn is using all the tools above. If she still doesn't have `get_route`, the agent loop's sub-calls will be just as dumb.
2. Pick a *real user request* that single-shot can't handle and use it as the eval target. Don't build agent loops on toy problems.
3. Build the planner as a separate file (`src/lib/penny/agent.ts`), invoked from a new endpoint, not by overloading `replan`.
4. Cap loop depth (probably 3) and budget per request ($0.50 hard ceiling) before any code ships.

---

## Open questions for future-Sam

1. Which tool is the highest-leverage to add first? My guess is `get_route` because every leg uses it, but `geocode` is cheaper and less risky.
2. Are we OK depending on Google for routes, or should we go to HERE/Mapbox to keep options open? (Affects pricing and the height-aware-routing path — see [`height-aware-routing.md`](./height-aware-routing.md).)
3. Where do tool *results* get stored? Some answers (route polylines, geocoded coords) are worth persisting on the leg row so we don't re-call. Others (weather) are ephemeral.
4. Should Penny be allowed to *speculatively* call tools without showing the user, or always call tools in response to a clear request? (Latency vs. helpfulness tradeoff.)
