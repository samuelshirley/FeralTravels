# CLAUDE.md — trip-planner

> **For AI assistants:** Use this file as your map — it tells you where everything is so you don't need to scan the whole codebase to orient yourself. Read specific files to verify details when a task requires it, but start here first.

## Vision

Personal automated travel agent for overlanders. The user tells Penny where they want to go and what they need along the way (fuel, water, groceries, rest stops) — Penny does all the legwork: builds the route, finds stops, plans fuel, and keeps the itinerary updated as things change. The user just drives and enjoys. Think of it as a copilot that actually knows how to read a map and plan logistics for a self-sufficient road trip.

## What this is

Overland trip planner. Next.js 14 app with an AI chat assistant ("Penny") that helps users plan multi-leg road trips with stops, routes, fuel planning, and GPX import. Deployed on Vercel, backed by Neon Postgres.

## Stack

- **Framework:** Next.js 14 (App Router, React 18)
- **DB:** Neon Postgres via `postgres` driver + Drizzle ORM
- **Auth:** NextAuth v5 (beta) — OTP email + Google OAuth
- **AI:** Anthropic SDK — chat agent with tool-use in `src/lib/penny/`
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
    coords.ts         # Coordinate parsing/formatting
    maps.ts           # Google Maps client helpers
    directions.ts     # Client directions logic
    gpx.ts            # GPX file parsing
    units.ts          # Unit conversion
    vehicleProfile.ts # Vehicle range/fuel calculations
    fuelPlanErrorSemantics.ts  # Fuel plan error handling
    google/directions.ts       # Server-side Google Directions API
    replan/
      engine.ts       # Deterministic replan engine (no AI tokens)
      emails.ts       # Morning/rest-day/off-route email templates
    penny/
      context.ts      # Builds context for Penny from trip data
      geo.ts          # Geo utilities for Penny
      split-route.ts  # Route splitting logic
      routingAvoidMerge.ts  # Avoid-highway merge logic
      tools/          # 18 Penny tools (see Penny Tools below)
  server/
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
api/cron/nightly-replan
```

### Schema (23 tables in `src/server/db/schema.ts`)

users, accounts, sessions, verificationTokens, emailOtpCodes, vehicles, trips, legs, legConstraints, costs, pois, links, gpxTrails, routes, routeLinks, stops, tasks, chatHistory, appMeta, usageEvents, userViewportTime, announcements, announcementDismissals

### Repos (`src/server/repos/`)

trips, routes, stops, vehicles, users, tasks, pois, chat, gpx, usage, admin, remediationFlags, announcements

### Penny Tools (`src/lib/penny/tools/`)

addStop, updateStop, deleteStop, addLeg, updateLeg, deleteLeg, addRoute, updateRoute, deleteRoute, getRoute, addTask, updateTask, updateVehicle, renameTrip, checkTripFeasibility, planFuelStops, planDumpStationStops, extractTripIntent — registered in `index.ts`, shared helpers in `shared.ts`

### Scripts (`scripts/`)

ship.sh, run-migrations.ts, seed-demo-trip.ts, seed-e2e-fixture.ts, cleanup-e2e.ts, smoke-api.ts, db-reset.ts, seed-migration-journal.ts, backfill-google-maps-nav.ts, backfill-anthropic-zero-cost-rows.ts, reconcile-anthropic-spend.ts, remediation-diagnose.ts, remediation-backfill-flags.ts, migrate-sqlite-to-neon.ts, verify-maps-waypoints.ts, seed-first-announcement.ts

### E2E Tests (`e2e/`)

existing-trip, login-otp, login-google-button, vehicle-crud, vehicle-remediation, onboarding-flow, onboarding-validation, penny-plan-trip, announcement

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
