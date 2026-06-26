# CLAUDE.md — trip-planner

> **For AI assistants:** Use this file as your map — it tells you where everything is so you don't need to scan the whole codebase to orient yourself. Read specific files to verify details when a task requires it, but start here first.

## Vision

Personal automated travel agent for overlanders. The user tells Penny where they want to go and what they need along the way (fuel, water, groceries, rest stops) — Penny does all the legwork: builds the route, finds stops, plans fuel, and keeps the itinerary updated as things change. The user just drives and enjoys. Think of it as a copilot that actually knows how to read a map and plan logistics for a self-sufficient road trip.

## MVP scope — current focus (hold the line)

> **Status (2026-06-26):** Deliberately scoping *down* to a small MVP that works perfectly, then shipping to production. Sam asked me to hold him to this. If a request adds scope beyond what's below, flag it as post-MVP **before** building — don't quietly re-expand the surface area.

**What the MVP is:** the user says where they want to go → the app builds a day-by-day plan (how far they drive each day) → it finds gas stations along the route within the vehicle's range. That's the whole product for v1.

**Value thesis:** the app earns its keep *on the trip*, not just in pre-planning. The plan is a moving, day-by-day thing the user adapts as reality changes ("we stopped early", "we're actually going here instead"). Build for adaptability, not a static itinerary.

**In for MVP:** accounts/auth · vehicle setup (needed for range math) · the day-by-day plan · the **progress anchor** ("which day am I on / I'm here now" — keep this, it powers the adaptive view) · **Penny chat as the way to edit the plan** · lazy gas-stop planning (skeleton built eagerly; the per-day fuel-stop search is **lazy-loaded when the user opens that day** — no explicit button — and results are cached with a timestamp, so a stale cache triggers a cheap price re-check rather than a full re-search).

**Cut now (half-built / out of scope):** nightly replan · proactive emails · cron jobs · overnight-stop finder · the `draft/active/completed` trip **lifecycle** (keep the progress anchor, which is a different thing). Removing these should also kill a chunk of current bug surface.

**Fuel pricing + stop-finding is a SEPARATE task/agent.** "The right price" is **not** in this slice. This app only exposes the interface a dedicated fuel-stop + pricing agent plugs into; that agent is built in its own task (it needs region-specific price-data research — EU has open price feeds, the US does not).

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
- **Maps:** Google Maps (client JS API + server Directions API + Places API for nearby stops/parks/photos)
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
    TripMap.tsx       # Google Maps view
    Itinerary.tsx     # Leg/stop/route display
    TasksSection.tsx  # Trip tasks
    stops/            # StopCard, StopsSection, MoreStopsModal (with tests)
    AnnouncementModal.tsx  # One-time announcement popup
    (+ AppNavbar, BottomNav, MobileFooter, Spinner, StatusBadge, etc.)
  lib/
    api.ts            # Client-side API helper
    models.ts         # Central registry of hardcoded Anthropic model IDs (PENNY_MODEL, DATE_PARSE_MODEL)
    coords.ts         # Coordinate parsing/formatting (sync; Google/Apple Maps URLs, lat/lng)
    coordsResolve.ts  # Server-side Maps URL resolution (short-link redirects); used by api/coords/parse and Penny chat enrichment
    maps.ts           # Google Maps client helpers
    directions.ts     # Client directions logic
    gpx.ts            # GPX file parsing
    units.ts          # Unit conversion
    vehicleProfile.ts # Vehicle range/fuel calculations
    fuelPlanErrorSemantics.ts  # Fuel plan error handling
    google/directions.ts       # Server-side Google Directions API
    penny/
      context.ts      # Builds context for Penny from trip data
      geo.ts          # Geo utilities for Penny
      schedule.ts     # Deterministic rest-day/leg-order materializer + route-continuity fixes (computeStartFixes — every leg must start where the previous ended); pure. Applied by trips.repairLegContinuity
      fuelTankState.ts # Pure continuous-drive tank math (km burned since last refuel); only actual fuel stops/trip start refill — rest days & overnights are NOT implicit refuels. DB shim: server/fuel.ts
      planSummary.ts  # Deterministic DB-derived plan facts (day counts, dates, totals, ETA via dayModel, deadline check) — source of truth for plan numbers shown to the user; Penny's prose must NOT state them
      sanitize.ts     # Strips/ detects tool-call markup leaked into Penny's text (she must emit prose only, never <invoke>/<parameter> XML)
      split-route.ts  # Route splitting logic
      routingAvoidMerge.ts  # Avoid-highway merge logic
      tools/          # 19 Penny tools (see Penny Tools below)
  server/
    onboarding.ts     # Deterministic form-in-chat (runs BEFORE any LLM call); trip_date step resolves the start date via parseStartDate
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
api/stops/[id]/swap-primary                        api/stops/[id]/find-alternative
api/routes                api/routes/[id]         api/routes/[id]/select
api/routes/[id]/links
api/legs/[id]/fuel-stops
api/vehicles              api/vehicles/[id]
api/directions            api/gpx                 api/gpx/[id]
api/tasks                 api/tasks/[id]
api/pois                  api/coords/parse
api/places/nearby-stops   api/places/nearby-parks api/places/photos
api/me                    api/me/preferences      api/me/vehicle-remediation
api/support               api/analytics/viewport-time
api/admin/test-error      api/admin/announcements
api/announcements/active  api/announcements/dismiss
api/debug/fuel
```

### Schema (23 tables in `src/server/db/schema.ts`)

users, accounts, sessions, verificationTokens, emailOtpCodes, vehicles, trips, legs, legConstraints, costs, pois, links, gpxTrails, routes, routeLinks, stops, tasks, chatHistory, appMeta, usageEvents, userViewportTime, announcements, announcementDismissals

`trips` carries a driver-progress anchor (`current_leg_id`, `current_lat/lng`, `progress_anchor_date`, `progress_updated_at`) set by the `reportPosition` tool; `getTripFull` re-anchors every leg's `date_iso` from it, and the itinerary collapses legs before `current_leg_id` as "behind you". An explicit report is a **floor**, not a freeze — `behindCutoffRank` (`src/lib/dates.ts`) takes the max of the report and the calendar, so a stale report no longer pins the view (the days-old "frozen itinerary" bug).

**Dormant DB remnants (MVP teardown, 2026-06-26):** the `trips.trip_status` column/enum (`draft/active/paused/completed`) and the vehicle `dump_station_*` columns + the `dump_station` stop type still exist but are now **unwired** — the lifecycle transitions, nightly replan, and dump-station/overnight finders were removed. Leave dormant or drop in a later migration; don't re-wire without revisiting MVP scope. Note: `trip.status` (`planning/research/confirmed/anchored`) is a *different*, still-live field — the workflow badge shown in the UI.

### Repos (`src/server/repos/`)

trips, routes, stops, vehicles, users, tasks, pois, chat, gpx, usage, admin, remediationFlags, announcements

### Penny Tools (`src/lib/penny/tools/`)

addStop, updateStop, deleteStop, addLeg, updateLeg, deleteLeg, addRoute, updateRoute, deleteRoute, getRoute, addTask, updateTask, updateVehicle, renameTrip, reportPosition, submitIdea, checkTripFeasibility, planFuelStops, extractTripIntent — registered in `index.ts`, shared helpers in `shared.ts`

- **reportPosition** records the driver's real-world progress: sets the trip's `current_leg_id` + position anchor, re-points the upcoming leg to start where they are, and re-anchors the calendar from now. This is the lever behind "I'm in X, didn't reach Y".
- **submitIdea** logs an unsupported-but-reasonable feature request to `usage_events` (provider `penny:user-idea`) so the team can read it — keeps Penny from faking capabilities the app lacks (e.g. fuel prices).

### Scripts (`scripts/`)

ship.sh, run-migrations.ts, seed-demo-trip.ts, seed-e2e-fixture.ts, cleanup-e2e.ts, smoke-api.ts, db-reset.ts, seed-migration-journal.ts, backfill-google-maps-nav.ts, backfill-anthropic-zero-cost-rows.ts, reconcile-anthropic-spend.ts, remediation-diagnose.ts, remediation-backfill-flags.ts, migrate-sqlite-to-neon.ts, verify-maps-waypoints.ts, seed-first-announcement.ts

### E2E Tests (`e2e/`)

existing-trip, login-otp, login-google-button, vehicle-crud, vehicle-remediation, onboarding-flow, onboarding-validation, penny-plan-trip, announcement

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
