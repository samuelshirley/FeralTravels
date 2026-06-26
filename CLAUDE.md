# CLAUDE.md — trip-planner

> **For AI assistants:** Use this file as your map — it tells you where everything is so you don't need to scan the whole codebase to orient yourself. Read specific files to verify details when a task requires it, but start here first.

## Vision

**One line (Sam, 2026-06-26):** Right now this is *simply a trip-planning app that finds cheap fuel along the way.* That's all it does. Nothing else ships until that works perfectly in production. Anything beyond "plan the route → find cheap fuel on it" is post-MVP — flag it before building.

Personal automated travel agent for overlanders. The user tells Penny where they want to go and what they need along the way (fuel, water, groceries, rest stops) — Penny does all the legwork: builds the route, finds stops, plans fuel, and keeps the itinerary updated as things change. The user just drives and enjoys. Think of it as a copilot that actually knows how to read a map and plan logistics for a self-sufficient road trip.

## MVP scope — current focus (hold the line)

> **Status (2026-06-26):** Deliberately scoping *down* to a small MVP that works perfectly, then shipping to production. Sam asked me to hold him to this. If a request adds scope beyond what's below, flag it as post-MVP **before** building — don't quietly re-expand the surface area.

**What the MVP is:** the user says where they want to go → the app builds a day-by-day plan (how far they drive each day) → it finds gas stations along the route within the vehicle's range. That's the whole product for v1.

**Stops — exactly two types (this is the line; hold it).** (1) **`fuel`** — gas stops Finn finds automatically along the route. (2) **`other`** — a place the user *explicitly* adds: they drop in a Google Maps link, an address, or a place name (the three inputs Penny's welcome message invites). These are the "user-added" stops; selected ones force the route through that point. Penny does **NOT** proactively find overnight spots, campgrounds, parks, groceries, or any other amenity — that auto-discovery is a post-MVP "leader" feature to be rebuilt properly later. `StopType` is `'fuel' | 'other'` and nothing else.

**Future architecture — per-stop-type finder services (NOT now):** Penny is the conductor, not the search engine. Today there is exactly one finder service — **Finn (fuel)** — and Penny only triggers Finn; for anything else she declines and asks the user to paste a Maps link. Each future stop type (groceries, overnight, stores, etc.) becomes its **own tuned algorithmic service** that owns its `StopType`, not new Penny smarts. The seam is already in place: `StopType` is the extension point, and `add_stop` is locked so Penny can only author `other` (fuel rows come exclusively from Finn). Adding a new finder later = new type + its own server-side service, plus Penny learning to call it. Don't build these now; don't let Penny fake them.

**Value thesis:** the app earns its keep *on the trip*, not just in pre-planning. The plan is a moving, day-by-day thing the user adapts as reality changes ("we stopped early", "we're actually going here instead"). Build for adaptability, not a static itinerary.

**In for MVP:** accounts/auth · vehicle setup (needed for range math) · the day-by-day plan · the **progress anchor** ("which day am I on / I'm here now" — keep this, it powers the adaptive view) · **Penny chat as the way to edit the plan** · lazy gas-stop planning (skeleton built eagerly; the per-day fuel-stop search is **lazy-loaded when the user opens that day** — no explicit button — and results are cached with a timestamp, so a stale cache triggers a cheap price re-check rather than a full re-search). **BUILT 2026-06-26 (migration 0013)** — see the "Lazy fuel sourcing" note under Schema below for what shipped (the cheap stale re-check awaits Finn's pricing task).

**Cut now (half-built / out of scope):** nightly replan · proactive emails · cron jobs · overnight-stop finder · the `draft/active/completed` trip **lifecycle** (keep the progress anchor, which is a different thing). Removing these should also kill a chunk of current bug surface.

**Fuel pricing + stop-finding is a SEPARATE task/agent.** "The right price" is **not** in this slice. This app only exposes the interface a dedicated fuel-stop + pricing agent plugs into; that agent is built in its own task (it needs region-specific price-data research — EU has open price feeds, the US does not).

**Finn fuel-stop contract (interface only for MVP — algorithm is Finn's own task, do NOT build now):** the app captures two range numbers per vehicle and hands both to Finn; how Finn *uses* them is out of this slice.

- `comfortable_range_km` — the everyday target Finn aims for. Finn's stop logic must be "don't run dry before the next reachable station," **not** "stop every comfortable_range_km." The greedy "only stop when you can't reach the next station, and pick the best station in range" approach is what prevents the redundant fill-up-then-fill-up-again-100km-later annoyance. Distance-interval stopping is the wrong model.
- `hard_max_range_km` — the absolute ceiling on a dry stretch. Finn must never route the driver into a fuel gap longer than this. This is the number that catches the "passed the last station before a 250km void and ran out" failure: the trigger is "next fuel is X km away and X exceeds safe remaining range → top up **here** even though you're not low," not distance driven.
- **Forced-stop reason is mandatory.** When geography forces a top-up the driver wouldn't otherwise make (e.g. stations at 100/200km then a 250km void → must top up at 200), Finn must NOT try to engineer the stop away — it's physics. Finn MUST attach a one-line reason ("next fuel is 250km away"). A forced stop *with* a reason feels smart; without one it feels broken. This reason string is the cheapest fix for the confusion and is a first-class requirement, not a nicety.
- **MVP stance:** store both numbers, Finn treats `hard_max` as a never-exceed ceiling, ship. The long-gap edge (e.g. far-north Norway, Australian outback — real: routine 200–400km gaps) is a documented known limitation leaning on driver intelligence ("trust but verify"); don't pull the routing algorithm into the MVP to chase it.

**Assumption:** full tank at trip start unless the user says otherwise; Penny states this at the end of onboarding.

**Process:** ship → market → real feedback → iterate agile. Resist re-expanding scope from inside Sam's head.

## What this is

Overland trip planner. Next.js 14 app with an AI chat assistant ("Penny") that helps users plan multi-leg road trips with stops, routes, fuel planning, and GPX import. Deployed on Vercel, backed by Neon Postgres.

## Stack

- **Framework:** Next.js 14 (App Router, React 18)
- **DB:** Neon Postgres via `postgres` driver + Drizzle ORM
- **Auth:** NextAuth v5 (beta) — OTP email + Google OAuth
- **AI:** Anthropic SDK — chat agent with tool-use in `src/lib/penny/`. Model IDs are hardcoded in one registry (`src/lib/models.ts`) — no per-request fallback chains; update there when a model is sunset.
- **Email:** Resend
- **Maps:** Google Maps (client JS API + server Directions API for routes + Places API for photos). **Fuel stations are NOT from Google** — Finn sources them from OSM Overpass; route geometry for fuel planning is OSRM (`lib/directions.ts`, free, no key).
- **Tests:** Vitest (unit), Playwright (e2e)
- **Language:** TypeScript throughout, Zod for validation

## Commands

```bash
npm run dev          # local dev server
npm run build        # production build
npm run test         # vitest unit tests
npm run e2e          # playwright (needs running app + seeded DB)
npm run e2e:smoke    # subset of critical e2e tests
npm run db:generate  # drizzle-kit generate migrations
npm run db:push      # push schema to DB
npm run db:migrate   # run migrations via tsx
npm run db:studio    # drizzle-kit studio (DB browser)
npm run ship         # deploy script (scripts/ship.sh)
```

## Workflow (current)

Pre-launch project with **no real users yet** — we build fast ("vibe coding") directly on `main`. No feature branches or PR review gate at this stage.

Division of labor:

- **Claude commits and pushes** finished work straight to `main` (after `tsc --noEmit` + `npm run test` pass).
- **Sam runs `npm run ship`** to deploy.

Keep commits scoped to the change at hand — don't sweep unrelated in-progress edits into the same commit unless asked.

**Run the unit tests after EVERY code change — not just before a commit.** After modifying any code, run `npm run test` (and `tsc --noEmit`) and make them pass before moving on. If the environment can't run the full Vitest suite (e.g. a Linux sandbox against macOS-built `node_modules`), run the test files you can in an isolated runner and at minimum type-check with `tsc --noEmit` and exercise the touched pure logic directly — never skip verification.

## Architecture

```
src/
  app/
    api/              # REST endpoints (see API Routes below)
    trips/            # Trip list + [tripId] workspace (TripWorkspace.tsx)
    admin/            # Admin dashboard: users/, vehicles/, chats/, errors/, announcements/
    login/            # OTP + Google auth flow (verify/ sub-route)
    settings/         # User settings page
    vehicle-setup/    # Vehicle onboarding
  components/
    ChatPanel.tsx     # Penny chat UI
    PennyPlanningVideo.tsx  # The dog-fetch clip Penny "sends" at the start of the post-onboarding full-trip build (the one turn we can predict will be long). Renders a persistent, looping, iMessage-style video bubble inside a REAL Penny message (ChatPanel inserts a UI-only `planningMedia` message at handoff via `sendChatMessage(..., insertPlanningMedia=true)`), so it stays in the transcript and the user can scroll back to it — it no longer vanishes when her reply streams in. Not persisted to chat history (session-only; gone on reload). Every other turn keeps the bare typing dots. Plays at natural 1x; asset URLs carry `?v=N` (ASSET_VERSION) to bust a cached old stub; degrades to poster (reduced motion) or nothing (asset: public/penny-planning.mp4 + .jpg). NOTE: PennyPlanningLoader.tsx is now a deprecated re-export shim — safe to delete.
    TripMap.tsx       # Google Maps view
    Itinerary.tsx     # Leg/stop/route display
    TasksSection.tsx  # Trip tasks
    stops/            # StopCard, StopsSection, MoreStopsModal (with tests)
    AnnouncementModal.tsx  # One-time announcement popup
    (+ AppNavbar, BottomNav, MobileFooter, Spinner, StatusBadge, etc.)
  lib/
    api.ts            # Client-side API helper
    models.ts         # Central registry of hardcoded Anthropic model IDs (PENNY_MODEL, DATE_PARSE_MODEL, RANGE_ESTIMATE_MODEL, ONBOARDING_SCAN_MODEL)
    coords.ts         # Coordinate parsing/formatting (sync; Google/Apple Maps URLs, lat/lng)
    coordsResolve.ts  # Server-side Maps URL resolution (short-link redirects); used by api/coords/parse and Penny chat enrichment
    maps.ts           # Google Maps client helpers
    directions.ts     # Client directions logic
    gpx.ts            # GPX file parsing
    units.ts          # Unit conversion
    vehicleProfile.ts # Vehicle range/fuel calculations
    fuelCache.ts      # Lazy fuel-cache TTL (FUEL_CACHE_TTL_MS = 48h) + isFuelCacheFresh; shared by server/fuel.ts and LegCard day-open loader
    fuelPlanErrorSemantics.ts  # Fuel plan error handling
    google/directions.ts       # Server-side Google Directions API
    osm/
      overpass.ts     # OSM Overpass client — Finn's fuel-station source (corridor query + parse; ODbL, storable)
    finn/             # The fuel-stop engine (deterministic core). See docs/design/finn-fuel-agent.md
      index.ts        # Barrel re-export (range, route, stationFilter, plan, tank-state)
      range.ts        # Comfortable (C) / hard-max (H) reachability math
      route.ts        # Project a station onto the route polyline (alongKm + detour proxy)
      stationFilter.ts # Eligibility filter: drop truck-only / private stations (classifyStation)
      plan.ts         # Greedy multi-stop placement (planLegFuelStops) — price-preference aware
    penny/
      context.ts      # Builds context for Penny from trip data
      geo.ts          # Geo utilities for Penny
      schedule.ts     # Deterministic rest-day/leg-order materializer + route-continuity fixes (computeStartFixes — every leg must start where the previous ended); pure. Applied by trips.repairLegContinuity
      fuelTankState.ts # Pure continuous-drive tank math (km burned since last refuel); only actual fuel stops/trip start refill — rest days & overnights are NOT implicit refuels. DB shim: server/fuel.ts
      planSummary.ts  # Deterministic DB-derived plan facts (day counts, dates, totals, ETA via dayModel, deadline check) — source of truth for plan numbers shown to the user; Penny's prose must NOT state them
      sanitize.ts     # Strips/ detects tool-call markup leaked into Penny's text (she must emit prose only, never <invoke>/<parameter> XML)
      autoContinue.ts # Pure helper for server-side auto-continue: appends a continuation nudge to the message list without breaking user/assistant alternation when a planning turn truncates (used by claude.ts loop)
      split-route.ts  # Route splitting logic
      routingAvoidMerge.ts  # Avoid-highway merge logic
      tools/          # 19 Penny tools (see Penny Tools below)
  server/
    onboarding.ts     # Deterministic form-in-chat (runs BEFORE any LLM call); trip_date step resolves the start date via parseStartDate. trip_intent submit runs onboardingIntentScan first (skips/prefills questions message 1 already answered)
    onboardingIntentScan.ts # First-message intent scan: ONE forced-tool Haiku call (ONBOARDING_SCAN_MODEL) reads the opening trip description and transcribes onboarding vars it contains (start_date_phrase → resolveStartDate; comfortable/hard-max range → validateScannedRange). LLM only transcribes; server re-validates each field. EXACT start date auto-skips trip_date with a confirm note; inferred range is stashed in trips.onboarding_scan and PREFILLED on the vehicle step (confirm-don't-assume — safety number). All-null result ⇒ ask normally. Extensible: add a nullable field + validated mapping
    parseStartDate.ts # resolveStartDate → {iso, assumed}: deterministic tryParseToISO first (exact), else LLM (forced record_parsed_date tool, DATE_PARSE_MODEL) pins a day OR picks a representative day within a vague timeframe (assumed); iso=null ONLY when no temporal signal at all. Onboarding turns null into ONE clarifying "what time of year?" question, then a "start today" fallback — start_date_parsed is NEVER null
    db/
      schema.ts       # All tables (see Schema below)
      client.ts       # Neon connection
    repos/            # Data access layer (see Repos below)
    auth/
      index.ts        # NextAuth config
      guards.ts       # Auth guard utilities
      admin.ts        # Admin allowlist
      otp.ts          # OTP generation/validation
      otp-email.ts    # OTP email sending
      magic-email.ts  # Magic link emails
      test-backdoor.ts # E2E test auth bypass
  types/trip.ts       # Shared TypeScript types
middleware.ts         # Root-level edge middleware (cookie check)
scripts/              # CLI utilities (see Scripts below)
drizzle/              # Generated migration SQL files
e2e/                  # Playwright test specs
```

### API Routes

```
api/auth/[...nextauth]    api/chat
api/trips                 api/trips/[id]          api/trips/[id]/clone
api/trips/[id]/onboarding api/trips/[id]/fuel-stops/replan
api/trips/[id]/position
api/trip                  api/trip/replan
api/stops                 api/stops/[id]          api/stops/[id]/select
api/stops/[id]/swap-primary
api/routes                api/routes/[id]         api/routes/[id]/select
api/routes/[id]/links
api/legs/[id]/fuel-stops
api/vehicles              api/vehicles/[id]
api/directions            api/gpx                 api/gpx/[id]
api/tasks                 api/tasks/[id]
api/pois                  api/coords/parse
api/places/photos
api/me                    api/me/preferences
api/support               api/analytics/viewport-time
api/admin/test-error      api/admin/announcements
api/announcements/active  api/announcements/dismiss
api/debug/fuel
```

### Schema (23 tables in `src/server/db/schema.ts`)

users, accounts, sessions, verificationTokens, emailOtpCodes, vehicles, trips, legs, legConstraints, costs, pois, links, gpxTrails, routes, routeLinks, stops, tasks, chatHistory, appMeta, usageEvents, userViewportTime, announcements, announcementDismissals

`trips` carries a driver-progress anchor (`current_leg_id`, `current_lat/lng`, `progress_anchor_date`, `progress_updated_at`) set by the `reportPosition` tool; `getTripFull` re-anchors every leg's `date_iso` from it, and the itinerary collapses legs before `current_leg_id` as "behind you". An explicit report is a **floor**, not a freeze — `behindCutoffRank` (`src/lib/dates.ts`) takes the max of the report and the calendar, so a stale report no longer pins the view (the days-old "frozen itinerary" bug).

`trips.onboarding_scan` (jsonb, migration 0012) is a transient stash mirroring `pending_intent`: the first-message intent scan (`onboardingIntentScan.ts`) writes validated, prefill-confirm onboarding values here (currently the fuel-range safety numbers) until the question that owns each comes up on the vehicle step; cleared at handoff. The start date isn't stashed — an exact one is applied immediately and its question skipped. See `OnboardingScan` in `types/trip.ts`.

**Vehicle range → Finn handoff (migration 0011):** `vehicles.refill_distance_km` was renamed to **`comfortable_range_km`** (the everyday target Finn aims for) and a new **`hard_max_range_km`** column added (the absolute ceiling Finn must never route a dry stretch past). Captured in onboarding (comfortable required; hard-max optional, **defaults to comfortable** — the one safe fallback). Invariant `comfortable_range_km ≤ hard_max_range_km` is enforced at every write path centrally in `repos/vehicles.ts` (`assertRangeOrder`). Both are projected to Penny/Finn via `projectVehicle` (`hard_max_range_km ?? comfortable_range_km`). Bounds remain `FUEL_STOP_SPACING_KM_MIN/MAX` (200–1500). Penny prose must still not author the safety number — onboarding/Settings/the `update_vehicle` tool convert + validate; the server re-checks. **"I don't know my range" path:** a non-numeric answer on the comfortable step routes to the `range_help` onboarding state → `src/server/parseComfortableRange.ts` (forced-tool estimator, `RANGE_ESTIMATE_MODEL`) proposes a conservative number from the driver's vehicle/tank info → prefilled back on the comfortable step for confirm/edit (never persisted unguarded; falls back to "type a number" if it can't estimate). Pure guard `validateComfortableKm` lives in `vehicleProfile.ts`. **Decided out:** `fuel_type` (not worth onboarding friction). **Follow-up:** collapse the redundant `effective_range_km`/`computeEffectiveRangeKm` alias into `comfortable_range_km`. See `docs/design/penny-comfortable-range.md`.

**Lazy fuel sourcing — BUILT (migration 0013, 2026-06-26):** fuel stops are now sourced **lazily on day-open**, not eagerly across the whole trip during planning (the old eager fan-out was the Google Places cost sink). New column `legs.fuel_stops_updated_at` is the cache timestamp; `FUEL_CACHE_TTL_MS` (48h, `src/lib/fuelCache.ts`) is the staleness window shared by server + client. Flow: the initial plan creates legs/routes only (no fuel calls — Penny's prompt no longer auto-calls `plan_fuel_stops`; she keeps it for **explicit** "find fuel for day N" asks). When the user expands a day, `LegCard`'s effect POSTs `/api/legs/[id]/fuel-stops`, which routes through `planFuelStopsForLegLazy` (`server/fuel.ts`): a terminal-success leg (`ready`/`no_stations_found`) sourced within the TTL is a **cache hit with zero Places calls**; never-sourced or stale legs run the real `planFuelStopsForLeg` search (algorithm untouched) and (re)stamp the cache. `setFuelStatus` stamps the timestamp on terminal-success and clears it on `none`. **Invalidation is affected-leg-only, never a trip-wide re-fan-out:** `invalidateLegFuelCache` (a leg's coords change via `update_leg`, `report_position` re-routing the upcoming leg, or continuity-repair) and `invalidateTripFuelCache` (vehicle/range change on `PATCH /api/trips/[id]`) reset `fuel_status='none'` + drop auto option stops so the affected day re-sources on next open. The "stale → **cheap** price re-check" the design calls for is Finn's separate pricing task (not built — no US price feed); until then a stale cache falls through to a full re-search, kept infrequent by the TTL gate. The trip-wide `replenishFuelStopsForTrip` + `POST /api/trips/[id]/fuel-stops/replan` + `api.replenishFuelStops` survive but are **no longer auto-triggered** (manual/admin re-plan only). See `docs/mvp-cleanup/06-lazy-fuel-sourcing.md`.

**Finn cutover — station source is now OSM, not Google Places (2026-06-26):** `planFuelStopsForLeg` (`server/fuel.ts`) was rebuilt to run on **Finn**: OSRM route geometry → **OSM Overpass corridor** (`lib/osm/overpass.ts`) → **eligibility filter** (`lib/finn/stationFilter.ts`, drops truck-only / private stations — the "St1 Truck" bug) → **route projection** (`lib/finn/route.ts`) → **greedy multi-stop placement** (`lib/finn/plan.ts`, never past `hard_max_range_km`, prefers comfortable range, prefers priced+cheapest once pricing exists). The lazy day-open flow, TTL cache, and invalidation seams are unchanged — only the guts behind `planFuelStopsForLeg` swapped. **Deleted:** `src/server/fuelPlaces.ts` (Google Places adapter) + `src/server/fuel.test.ts` (its tests). There is now exactly **one** fuel planner. Fuel `stops.source` is now `'osm'` (was `'google_places'`); OSM stations have no Google `place_id`, so the "open in Maps" link is built from lat/lng (`StopCard` already falls back to coords). **Pricing not built yet** — every candidate is price-unknown today; the regional price providers (Tankerkönig/etc. + live Google `fuelOptions` fallback) and the tri-state price display are the next phase. `legs.fuel_plan_hash`/`fuel_planned_at` and `trips.start_fuel_fraction` from the ADR are also still TODO. New tests: `lib/finn/plan.test.ts`, `lib/finn/stationFilter.test.ts`. See `docs/design/finn-fuel-agent.md`.

**Dormant DB remnants (MVP teardown, 2026-06-26):** the `trips.trip_status` column/enum (`draft/active/paused/completed`) still exists but is **unwired** (lifecycle transitions removed). Leave dormant or drop in a later migration; don't re-wire without revisiting MVP scope. Note: `trip.status` (`planning/research/confirmed/anchored`) is a *different*, still-live field — the workflow badge shown in the UI.

**Dump station — fully removed (migration 0015, 2026-06-26):** the vehicle `dump_station_interval_days` / `dump_station_tracking_enabled` columns were **dropped** and the `dump_station` **stop type** + its finder were deleted: `server/dump-stations.ts`, `server/places/nearby-dump-stations.ts`, `POST /api/stops/[id]/find-alternative`, the "Find other station" button in `StopsSection`, the `dump_station` `StopCard`/`LegCard` rendering, and `dump_station` from every `stop_type` enum (`shared.ts`, `addStop`, `updateStop`, `api/stops`, `api/stops/[id]`, `StopType`). `stops.stop_type` is a plain text column so no enum migration was needed.

**Onboarding teardown (MVP, 2026-06-26):** onboarding now collects only the vehicle **name + comfortable range (+ optional hard-max ceiling)**.

**Travel style — fully deleted (migration 0014, 2026-06-26):** there is no travel-style concept anywhere anymore — Penny has no notion of it. The columns `vehicles.travel_style` (+ the `travel_style` pg enum), `cruise_max_drive_hours`, `transit_max_drive_hours`, `max_drive_hours_per_day`, `max_drive_hours_per_week` were **dropped** (migration `0014_drop_travel_style_and_remediation.sql`), along with all code: `TravelStyle`/`TRAVEL_STYLE_OPTIONS`/`deriveFromTravelStyle`/`deriveMaxDriveHoursPerWeek` helpers, the per-leg cap projection, and the Settings/admin display. Every driving day is now capped at a flat **`DEFAULT_MAX_DRIVE_HOURS_PER_DAY = 8`** (`vehicleProfile.ts`) — the leg validators (`addLeg`/`updateLeg`) and `get_route` splitting use the constant directly, no per-vehicle cap. The `update_vehicle` Penny tool carries only `comfortable_range_km`/`hard_max_range_km`. The driving-cadence columns `max_consecutive_drive_days` / `rest_days_after_driving` were also **dropped** (migration `0015_drop_vehicle_cadence_dump_columns.sql`, alongside the dump-station columns). The MVP `vehicles` row is now just name + comfortable/hard-max range.

**Stop-type teardown — DONE (2026-06-26):** `StopType` reduced to **`'fuel' | 'other'`** (`other` = the user-added stop: link/address/place name). Removed the `food` (groceries) and `overnight` stop types and the `rest` (parks) **stop type**, plus all their wiring: the parks/groceries finders (`server/places/nearby-parks.ts` + `api/places/nearby-parks`), the dead `nearby-stops` route/stub, the deprecated `MoreStopsModal` (+ test), `api.ts nearbyParks`, the overnight route-option split + `variant='overnight'` StopCard styling in `StopsSection`/`StopCard`, and `useStopActions` `addNearbyPlace`/`setOvernight` (the paste-GPS flow now tags stops `other`, not `overnight`). `fuel.ts` lost its legacy auto-stretch-break `rest` references (`AUTO_STRETCH_BREAK_NOTE_PREFIX`; the break-finding feature was already gone). The Penny prompt (`claude.ts`) no longer tells her to emit `overnight` stops or offer amenity finding. Enums trimmed in `shared.ts`, `addStop`, `updateStop`, `api/stops`, `api/stops/[id]`, `types/trip.ts`. `stops.stop_type` is plain text → no migration; legacy `food`/`overnight`/`rest` rows (none in prod — no users yet) would just be orphan strings, optionally swept to `other`. **NOT touched:** the `leg_type: 'rest'` rest-**day** path, and `add_route` alternative-destination (route-option) picking — both stay. **Deferred (post-MVP):** the `dog_park`/`park` **route-link** types in `routeLinkTypeSchema`/`addRoute`/`updateRoute` are still present (separate from stops); trim later if desired.

**Penny never authors fuel stops — ENFORCED (2026-06-26):** the global `stopTypeSchema` stays `'fuel' | 'other'` (the server-side fuel planner + repo + API still write `fuel` rows), but **Penny's `add_stop` tool is now locked to `stop_type: 'other'` only** (`addStopTypeSchema = z.literal('other')` in `addStop.ts`; fuel_type/fuel_amount fields removed from that tool, and the `route.ts` dispatcher hard-codes them to null). `update_stop`'s *settable* `stop_type` is likewise `'other'`-only, so Penny can update an existing fuel stop's status/coords but can't convert anything **into** fuel. **Why:** `add_stop` previously let Penny mint a coordinate-less placeholder fuel row (e.g. "Fuel stop — Aurdal (departure)", 0 km, source `penny`) that pointed at no real station — an empty stop that does nothing. Architecture is now: Penny is the comms layer; **every fuel request routes to Finn via `plan_fuel_stops`** (real OSRM route + OSM Overpass station search), the only `add_stop` Penny does is a user-named `other` place. `<fuel_planning_rules>` in `claude.ts` rewritten to match (and the stale "dump stations/overnight/food" capability line fixed). Known gap (Finn's task, not built): Finn's greedy planner won't place a stop "exactly at the start"/at a named km — Penny reports "none needed" honestly instead of faking a marker. Test: `addStop.test.ts`.

**Vehicle remediation — fully removed (migration 0014, 2026-06-26):** the multi-step remediation overlay/wizard was deleted. Onboarding always collects the comfortable range, so the only completeness signal needed is a live check in `buildPennyContext` (`vehicle_profile_blocked = !vehicleMeetsFuelPlanningMinimum(...)`) that lets Penny nudge "set your range" in chat. Gone: the `users.needs_vehicle_profile_remediation` column, `server/vehicleRemediation.ts`, `repos/remediationFlags.ts`, `vehicleRemediationGateLog.ts`, `GET/POST /api/me/vehicle-remediation`, the `VehicleRemediationOverlay` UI in `ChatPanel`, the `remediation-diagnose`/`remediation-backfill` scripts, and the `vehicle-remediation` e2e spec. `vehicleIsCompleteForRemediation`/`storedVehicleProfileFieldNeedsRemediationRepair`/`vehicleMeetsCompletenessTier` were deleted from `vehicleProfile.ts`. See `docs/mvp-cleanup/01-onboarding-teardown.md`.

### Repos (`src/server/repos/`)

trips, routes, stops, vehicles, users, tasks, pois, chat, gpx, usage, admin, announcements

### Penny Tools (`src/lib/penny/tools/`)

addStop, updateStop, deleteStop, addLeg, updateLeg, deleteLeg, addRoute, updateRoute, deleteRoute, getRoute, addTask, updateTask, updateVehicle, renameTrip, reportPosition, submitIdea, checkTripFeasibility, planFuelStops, extractTripIntent — registered in `index.ts`, shared helpers in `shared.ts`

- **reportPosition** records the driver's real-world progress: sets the trip's `current_leg_id` + position anchor, re-points the upcoming leg to start where they are, and re-anchors the calendar from now. This is the lever behind "I'm in X, didn't reach Y".
- **submitIdea** logs an unsupported-but-reasonable feature request to `usage_events` (provider `penny:user-idea`) so the team can read it — keeps Penny from faking capabilities the app lacks (e.g. fuel prices).

### Scripts (`scripts/`)

ship.sh, run-migrations.ts, seed-demo-trip.ts, seed-e2e-fixture.ts, cleanup-e2e.ts, smoke-api.ts, db-reset.ts, seed-migration-journal.ts, backfill-google-maps-nav.ts, backfill-anthropic-zero-cost-rows.ts, reconcile-anthropic-spend.ts, migrate-sqlite-to-neon.ts, verify-maps-waypoints.ts, seed-first-announcement.ts

### E2E Tests (`e2e/`)

existing-trip, login-otp, login-google-button, vehicle-crud, onboarding-flow, onboarding-validation, penny-plan-trip, lazy-fuel-sourcing, announcement

## Lockdown invariants (load-bearing — do not loosen)

The trust boundary is strict on purpose. Everything that crosses into the app or the DB must match a narrow, pre-declared shape; nothing free-form is persisted or trusted.

- **Endpoints are locked down.** Every API route accepts ONE specific Zod-validated payload and nothing else. Do NOT widen an endpoint to accept loose / free-text / "smart" input to be helpful — reject anything off-contract. Free-text interpretation (e.g. a human-typed date) belongs ONLY at the dedicated input boundary that owns it (onboarding), never bolted onto a general edit endpoint. Example: `PATCH /api/trips/[id]` expects an already-resolved date — it must NOT run the LLM date parser.
- **The DB is locked down.** All access goes through `src/server/repos/*` (no raw SQL in routes); invariants like `trips.start_date_parsed` are non-null machine values, never raw human text.
- **The LLM converts, it does not author.** When an LLM call is used, its job is to turn messy user input into EXACTLY the structured value the API/DB already expects — and the structure is forced (a tool/`tool_choice` schema or equiv), not requested in prose. The model can only hand back the declared shape; it can't free-type a result. Then the server re-validates that shape before anything is persisted (e.g. `parseStartDate.ts`: forced `record_parsed_date` tool → `validateISODateString` → only the validated ISO is stored). This is what prevents hallucinated/oddly-formatted values from becoming bugs. When adding or editing an LLM call, make the expected result as specific as possible (tight schema + explicit "return null rather than guess" instructions).

## Patterns

- **Repo pattern:** All DB queries go through `src/server/repos/*.ts` — never raw SQL in routes.
- **API routes** are thin: validate input with Zod, call repo, return JSON.
- **Penny tools** each export a single function matching the Anthropic tool-use spec. Tool index in `src/lib/penny/tools/index.ts`.
- **Units:** User preference (metric/imperial) stored in DB, propagated via `UnitsContext`.
- **Schema:** Single file at `src/server/db/schema.ts`. Drizzle manages all migrations.
- **Auth middleware:** Edge-safe cookie check in root `middleware.ts`; real auth via `auth()` in server code.

## Conventions

- No `any` types. Use Zod schemas for API input validation.
- CSS Modules for component-scoped styles (e.g., `admin.module.css`).
- Server components by default; `"use client"` only when needed.
- Env vars: copy `.env.example` to `.env`. Never commit `.env`.
- Admin access: hardcoded allowlist in `src/server/auth/admin.ts`.
- **Never silently swallow errors.** Every mutation must either show inline error UI or go through the global `ErrorNotifier`. No empty `catch` blocks, no `console.error`-only handling. If something fails, the user must know.

## Working with this codebase

- **Schema changes:** Edit `schema.ts` → `npm run db:generate` → `npm run db:migrate`
- **New API route:** Create `src/app/api/<resource>/route.ts`, add repo if needed
- **New Penny tool:** Add to `src/lib/penny/tools/`, register in `index.ts`
- **E2E tests:** Need a running dev server and seeded test DB (`npm run e2e:seed`)

## Keeping this file current

**This is mandatory.** Whenever you make a change that affects the structure documented above, update this file in the same session. Specifically:

- **Added/removed an API route** → update the API Routes list
- **Added/removed a Penny tool** → update the Penny Tools list and tool count
- **Added/removed a repo** → update the Repos list
- **Changed the schema (new/dropped table)** → update the Schema list and table count
- **Added a new page or major component** → update the Architecture tree
- **Added/removed a script** → update the Scripts list
- **Added/removed an e2e test** → update the E2E Tests list
- **Changed the stack (new dependency, swapped service)** → update the Stack section

Don't wait until the end — update CLAUDE.md as part of the same commit as the structural change.
