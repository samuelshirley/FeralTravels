# CLAUDE.md — trip-planner

> **For AI assistants:** this is a **map**, not a manual — where things are and
> what you must not break, so you can orient without scanning the codebase. It is
> **guarded at 28 KB** (`src/lib/claudeMdGuard.test.ts`): narrative lives in
> `docs/`, linked from the line that summarises it, so read that doc when your
> task touches the area. Before adding anything here, read **Keeping this file
> current**.

## MVP scope — hold the line

**One line (Sam, 2026-06-26):** this is *simply a trip-planning app that finds
cheap fuel along the way.* Anything beyond "plan the route → find cheap fuel on
it" is post-MVP — flag it before building. Full scope and what was cut:
**`docs/design/mvp-scope.md`**.

- The user says where they want to go → the app builds a day-by-day plan → it
  finds gas stations along the route within the vehicle's range. That is v1.
- **Stops are exactly two types:** `fuel` (found by Finn, server-side) and
  `other` (a place the user explicitly added). `StopType` is `'fuel' | 'other'`
  and nothing else. Penny does NOT proactively find campgrounds or groceries.
- Penny is the conductor, not the search engine. One finder service today —
  **Finn (fuel)**; each future stop type becomes its own server-side service.
  Don't build these now; don't let Penny fake them.
- One range number per vehicle (`vehicles.range_km`). Finn's rule is "don't run
  dry before the next reachable station", never "stop every range_km", and a
  forced stop MUST carry a one-line reason. Full tank at trip start.

## Stack

An overland trip planner: Next.js 14 + an AI assistant ("Penny") planning
multi-leg road trips — stops, routes, fuel, GPX. Why each choice and what it
costs: **`docs/design/stack.md`** — read it before reasoning about cost or about
which provider serves what; this has been wrong here before, expensively.

- **Framework:** Next.js 14 (App Router, React 18) · **DB:** Neon Postgres via
  `postgres` + Drizzle ORM · **Email:** Resend
- **Auth:** NextAuth v5 (beta) — OTP email + Google OAuth. ONE address has a
  fixed code for App Store review, armed only by `APPLE_REVIEW_SIGNIN=1` and
  removed after approval — `docs/design/ios-review-notes.md` §1.
- **AI:** Anthropic SDK. Model IDs in one registry (`src/lib/models.ts`), API key
  resolved in one place (`src/lib/anthropicKey.ts`). Penny runs on Haiku 4.5.
- **Maps / geo:** Google — client JS, server Directions, Places (New)
  `searchText` for name→coords, Places Text Search along-route for Finn's
  stations. **These calls are PAID.** Coords→name is Nominatim: the Geocoding
  API is not enabled on the key.
- **There is exactly ONE Google key** — `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, for
  browser AND server. `GOOGLE_MAPS_SERVER_API_KEY` is dead scaffolding, not set;
  never propose "use the server key" as a fix.
- **Payments:** Apple IAP via RevenueCat (`mobile/`)
- **Tests:** Vitest (unit) · Playwright (web e2e) · Maestro (iOS e2e, simulator)
- **Language:** TypeScript throughout, Zod for validation

## Commands

```bash
npm run dev          # local dev server
npm run build        # production build
npm run test         # vitest unit tests
npm run e2e          # playwright (needs running app + seeded DB)
npm run e2e:smoke    # subset of critical e2e tests
npm run db:generate  # drizzle-kit generate migrations
npm run db:migrate   # run migrations via tsx
npm run db:push      # push schema to DB (fresh DBs only)
npm run db:studio    # DB browser
```

## Workflow — PR, preview, merge-is-deploy

The full pipeline and its accepted sharp edges:
**`docs/design/deploy-pipeline.md`**. Read it before changing CI.

**Production has NO real users yet**, and will not until Sam says the app is
launched, in words. Never weigh "this would affect N production accounts" as a
reason to slow down or pick the cautious option. It is still live infrastructure:
never run tests or seed fixtures against the prod database.

1. **Open a PR into `main`.** `ci.yml` runs unit tests, deploys a tested preview
   on an ephemeral Neon branch (a clone of prod), runs Playwright against it, and
   typechecks `mobile/`. There is no single `pipeline.yml`.
2. **Merge the PR — that IS the deploy.** `deploy-production.yml` re-verifies CI
   was green for the PR's head SHA, migrates prod, deploys via Vercel.
3. **PR closes** → `pr-cleanup.yml` drops the preview's Neon branch.

- **The deploy gate is enforced; branch protection is NOT.** A direct push or a
  mid-run merge moves `main` and then fails the deploy, leaving prod stale rather
  than half-migrated. Keep migrations additive.
- **Only the newest preview URL works** — a stale one fails as a fake sign-out
  (`/login`) because its database was dropped. Take it from the sticky comment.
- **The Anthropic-spending specs are behind the `ai-tests` label**
  (`penny-plan-trip`, `chat-maps-link`); add it when you are ready to merge.
- **Claude commits** finished work (after `tsc --noEmit` + `npm run test` pass);
  **Sam pushes, opens the PR, and merges.** Keep commits scoped, and **run the
  unit tests after EVERY code change**, not just before a commit.

## Architecture

Annotated tree — what each piece is for, and the bug that shaped it:
**`docs/design/architecture.md`**.

```
src/
  app/
    api/              # REST endpoints (see API Routes)
    trips/            # Trip list + [tripId] workspace (TripWorkspace.tsx)
    admin/            # users/ vehicles/ chats/ errors/ announcements/ deleted/
    login/  settings/  vehicle-setup/
    (legal)/          # PUBLIC — /privacy /terms /support. NO auth() in here.
    error.tsx         # The app's ONLY error boundary; branches on error.digest
  components/         # ChatPanel, TripMap, Itinerary, stops/, AppNavbar,
                      # BottomNav, DeviceLocationContext (THE client GPS owner)
  lib/                # pure logic, much of it mirrored into mobile/shared/
    osm/nominatim.ts  # reverse geocode (coords -> name), 1 req/s, never throws
    google/           # geocode.ts (name -> coords), directions.ts
    finn/             # fuel-stop engine — docs/design/finn-fuel-agent.md
    penny/            # context, schedule, planSummary, sanitize, turnTrace,
                      # contiguityGate, legPlacement, editOverride, tools/
  server/             # onboarding.ts onboardingIntentScan.ts parseStartDate.ts
    db/               # schema.ts (all tables), client.ts (Neon)
    repos/            # Data access layer (see Repos)
    payments/         # BOUNDED MODULE — index.ts is the only public surface
    auth/             # guards.ts admin.ts otp.ts test-endpoints.ts
                      # sessionStore.ts otp-email.ts magic-email.ts
  types/trip.ts       # Shared TypeScript types
middleware.ts  scripts/  drizzle/  e2e/  mobile/
```

### API Routes

```
api/admin/announcements api/admin/paywall api/admin/paywall/user
api/admin/penny-lock api/admin/promo api/admin/subscription/reactivate
api/admin/subscription/revoke api/admin/test-error api/admin/test-users
api/analytics/client-error api/analytics/viewport-time
api/announcements/active api/announcements/dismiss api/auth/[...nextauth]
api/chat api/debug/fuel api/gpx api/gpx/[id] api/legs/[id]/fuel-stops api/me
api/me/delete api/me/entitlement api/me/identity api/me/preferences
api/mobile/oauth/exchange api/mobile/otp/send api/mobile/otp/verify api/pois
api/promo/redeem api/routes api/routes/[id]
api/routes/[id]/links api/routes/[id]/select api/stops api/stops/[id]
api/stops/[id]/select api/stops/[id]/swap-primary api/support api/tasks
api/tasks/[id] api/test/announcement api/test/breakers api/test/cleanup
api/test/deletion api/test/otp api/test/promo api/test/seed
api/test/subscription api/test/trip api/test/turn api/trip api/trip/replan
api/trips api/trips/[id] api/trips/[id]/clone api/trips/[id]/onboarding
api/trips/[id]/position api/trips/[id]/turns api/vehicles api/vehicles/[id]
api/webhooks/revenuecat
```

**`api/test/*` are TEST-ONLY** (fixture DATA only), backed by
`repos/testSupport.ts` — see the E2E auth note below for the three guards.

### Schema (33 tables in `src/server/db/schema.ts`)

Migration history, reasoning and traps: **`docs/design/schema.md`**. Read it
before touching these — several carry non-obvious contracts (account deletion's
email-keyed rows, `penny_turns` concurrency).

users, accounts, sessions, verificationTokens, emailOtpCodes, oauthTokenUses,
vehicles, trips, legs, costs, pois, links, gpxTrails, routes, routeLinks, stops,
tasks, chatHistory, appMeta, usageEvents, userViewportTime, announcements,
announcementDismissals, pennyTurns, deletedUsers, subscriptions,
subscriptionEvents, usageAlerts, promoCodes, otpSendThrottle, breakerAlerts,
ipRequestCounters, oauthProviderKeys

**Dormant columns** (present, unwired — don't re-wire without revisiting scope):
`trips.trip_status`, `legs.status`, `trips.status`, `stops.photos`,
`stops.price_*`.

### Repos (`src/server/repos/`)

trips, routes, stops, vehicles, users, tasks, pois, chat, gpx, usage, admin,
announcements, pennyTurns, accountDeletion, oauthJwks, testSupport (test-only)

### Penny Tools (`src/lib/penny/tools/`)

What she may and may not author, and why each lock exists:
**`docs/design/penny-tools.md`**.

addStop, updateStop, deleteStop, addLeg, updateLeg, deleteLeg, addRoute,
updateRoute, deleteRoute, getRoute, resolvePlace, addTask, updateTask,
updateVehicle, renameTrip, reportPosition, submitIdea, checkTripFeasibility,
planFuelStops, declareFuelState, extractTripIntent — 21 tools, registered in
`index.ts`, shared helpers in `shared.ts`.

**Penny does not author derived fields.** Coordinates come only from
`resolve_place`; leg titles are derived `start → end`; `trips.end_date` is
re-derived from the legs; `place_id` is forwarded untouched. `add_stop` is locked
to `'other'` (fuel rows come only from Finn); range writes to onboarding +
Settings.

### Scripts (`scripts/`)

What each is for and its traps: **`docs/design/scripts.md`**.

```
anthropic-usage-report.ts assert-e2e-ran.mjs
backfill-anthropic-zero-cost-rows.ts backfill-google-maps-nav.ts check-env.sh
check-preview-env.mjs claude-task.sh db-reset.ts debug-trip.ts
decide-docs-only.mjs decide-mobile-release.mjs dump-trip.ts e2e-pr-summary.mjs
extract-canonical-trip.ts generate-apple-client-secret.ts
handoff-bug-campaign.sh iap-preflight.sh iap-webhook-secret.sh
ios-e2e-fixture.mjs ios-e2e-local.sh lifetime-spend.ts make-test-user.ts
measure-message-gate.ts migrate-sqlite-to-neon.ts pick-ios-simulator.mjs
pick-screenshot-simulator.mjs prune-branches.sh reconcile-anthropic-spend.ts
run-migrations.ts seed-demo-trip.ts seed-first-announcement.ts
seed-migration-journal.ts serverOnlyStub.ts set-ios-oauth-client-id.mjs
set-paywall-flag.mjs sim-frames.swift smoke-api.ts storekit-probe.sh
sync-shared.mjs trial-account.ts vercel-set-ci-key.sh verify-maps-waypoints.ts
```

**Tombstones — do not recreate.** `scripts/ship.sh` and `npm run ship` are
**GONE** (deleted 2026-08-14): it pushed straight to prod outside every gate.
Open a PR instead. `seed-e2e-fixture.ts` and `cleanup-e2e.ts` were also
**removed** — e2e seeds over HTTP from `global-setup.ts`.

### E2E Tests (`e2e/`)

What each proves: **`docs/design/e2e-tests.md`**.

existing-trip, login-otp, login-google-button, vehicle-crud, onboarding-flow,
onboarding-validation, penny-plan-trip, chat-maps-link, units-imperial,
lazy-fuel-sourcing, announcement, account-deletion, legal-pages, oauth-exchange,
breakers, chat-tab-in-flight, viewport-hint, subscriptions, promo

**E2E auth: no session bypass exists.** Every authenticated spec signs in through
the REAL OTP flow, reading its own fixture address's code from
`POST /api/test/otp`; nothing is minted and nothing granted. The `/api/test/*`
endpoints need all three of `E2E_TEST_ENDPOINTS=1` (hard-off on production, no
override), a per-run HMAC, and `FIXTURE_EMAIL_PATTERN` (hardcoded, on a subdomain
with no MX). `src/lib/noBackdoorGuard.test.ts` fails the suite if a test sign-in
reappears in `src/`.

### iOS E2E (`mobile/maestro/`)

`launch.yaml`, `sign-in.yaml`, `chat-keyboard.yaml`, `chat-tab-in-flight.yaml`,
`onboarding-flash.yaml`, `settings-location.yaml`, `screenshots.yaml` — Maestro
flows driving a real iOS simulator against the PR's own preview. **Start at
`docs/design/ios-e2e-bringup.md`**: what is proven, what is not, and the traps
(Xcode pairing, Release-vs-Debug, the keychain, the software keyboard).

## Lockdown invariants (load-bearing — do not loosen)

- **Endpoints are locked down.** Every API route accepts ONE Zod-validated
  payload and nothing else. Do NOT widen one to accept loose or free-text input
  to be helpful — free-text interpretation belongs ONLY at the boundary that
  owns it (onboarding), never on a general edit endpoint.
- **The DB is locked down.** All access goes through `src/server/repos/*` — no
  raw SQL in routes. Invariants like `trips.start_date_parsed` are non-null
  machine values, never raw human text.
- **The LLM converts, it does not author.** Its job is to turn messy input into
  EXACTLY the structured value the DB expects, and the structure is **forced** (a
  tool schema + `tool_choice`), never requested in prose. The server re-validates
  before persisting. Tell the model to return null rather than guess.
- **`src/server/payments/` is a bounded module.** `index.ts` is its only public
  surface, `hasEntitlement(userId)` its only public question; nothing outside
  imports `./states`, `./entitlements`, or the `subscriptions` table.

## Patterns

- **Repo pattern:** all DB queries through `src/server/repos/*.ts`.
- **API routes are thin:** validate with Zod, call repo, return JSON.
- **Penny tools** each export one function matching the Anthropic tool-use spec.
- **Units:** user preference stored in DB, propagated via `UnitsContext`.
- **Schema:** single file, `src/server/db/schema.ts`; Drizzle manages migrations.
- **Auth:** edge-safe cookie check in root `middleware.ts`; real auth via
  `auth()` in server code. Mobile sends `Authorization: Bearer <token>` resolved
  against the same `sessions` table — not a parallel auth system, not a bypass.
- **Shared code:** `src/shared/` mirrors into `mobile/shared/` via
  `node scripts/sync-shared.mjs`; run it after touching either.

## Conventions

The incident behind each — the part that stops it being re-broken — is in
**`docs/design/conventions.md`**. Load-bearing:

- **Copy rule.** Every string on screen must tell the user something they cannot
  already see — no filler, no restating a button in a sentence. If a control
  needs a paragraph to be understood, the control is wrong. The exception is a
  DESTRUCTIVE action, where enumerating what is destroyed is information.
- **Never silently swallow errors.** Every mutation either shows inline error UI
  or goes through the global `ErrorNotifier`. No empty `catch`, no
  `console.error`-only handling.
- **A database failure is not a sign-out.** `auth()` wraps Auth.js to tell
  "signed out" apart from "the session store is down", which is **503, never
  401** — `mobile/lib/api.ts` clears the keychain on 401. `rawAuth` belongs to
  `/login` and `/login/verify` only. Likewise, OAuth provider keys that cannot be
  fetched are 503 `ProviderUnavailable`, never 401 `InvalidToken`.
- **A server module never CALLS a value imported from a `'use client'` module** —
  rendering a client component is fine, calling one of its plain exports throws
  at render and is invisible to `tsc` (`serverClientBoundaryGuard.test.ts`).
- **No `any` types.** Zod for API input; CSS Modules for styles; server
  components by default, `"use client"` only when needed.
- **Native:** `KeyboardAvoidingView` lives at the SCREEN root, never inside
  `ChatPanel`, which never adds `insets.bottom` (its host owns the safe area).
- **Env vars:** copy `.env.example` to `.env`; never commit it. Admin access is a
  hardcoded allowlist in `src/server/auth/admin.ts`.
- Four more are guard-enforced rather than memory-enforced: `noHardcodedUnits`
  (imperial sees no km), `goHereLinks` (a drive, not a pin), `nativeErrorCopy`
  (every error code has client copy), `AppNavbar` (avatar: photo or glyph).

## Subscriptions, paywall, and spend defence

Account states, promo codes, revoke/undo, breakers, per-IP limits, the message
gate: **`docs/design/subscriptions.md`** — read it before touching any spend or
entitlement path.

- Seven days free from `users.created_at`, then $2/month or $20/year via Apple
  IAP. The **RevenueCat webhook is the ONLY thing that may grant access.**
- The paywall master switch is a DATABASE ROW (`app_meta.paywall_enabled`)
  flipped from `/admin`, so turning it off needs no redeploy. It **fails closed,
  to OFF**; the breakers **fail CLOSED**; the message-gate classifier **fails
  OPEN**. Each direction is deliberate.
- A tripped breaker is **503 `circuit_open`** — never 401 (which clears the iOS
  keychain), never 402 (the paywall's word).

## Working with this codebase

**`docs/design/working-with-this-codebase.md`** — migration chain, timezone defect.

- **Schema change:** edit `schema.ts` → `npm run db:generate` → `npm run db:migrate`
- **New API route:** `src/app/api/<resource>/route.ts`, add a repo if needed.
- **New Penny tool:** add to `src/lib/penny/tools/`, register in `index.ts`.
- **E2E:** Playwright starts the app and seeds over HTTP in `global-setup.ts`.
- **Declare every new timestamp column `{ withTimezone: true }`.** Without a zone
  drizzle gives a wrong answer on any non-UTC database; migration 0032 converted
  all 43 and none should reappear.
- **The migration chain cannot be replayed from an empty database** — it never
  has been. A fresh DB uses `db:push` + `seed-migration-journal.ts`.

## Reproduce, never guess

Before naming a cause, make the failure happen — not from a code comment, a
commit message, or a plausible theory. If it cannot be reproduced, say so plainly
instead of a confident explanation. **Read tense before quoting a comment as a
cause:** a postmortem of a fixed problem is not a live action item.

**Playwright MCP — use it FIRST** (`.mcp.json` registers it). For anything
Playwright — a spec, a locator, a failure — drive a real browser through the flow
**before** theorising, pointed at the deployed preview (URL in the PR's sticky
comment), not a local dev server. Reasoning from a CI log instead is how three
days went into a mail-provider migration for a React hydration crash that was
visible in the console in ten seconds. How to reproduce CI-only, clock and
production failures: **`docs/design/playwright-mcp.md`**.

**Mutation-check every new guard test** — reintroduce the exact bug, watch it
fail, restore; an unverified guard is decoration. Register any new
`src/lib/*Guard.test.ts` in `docs/decisions.md` or
`decisionsRegisterGuard.test.ts` fails the suite.

## Keeping this file current

The guard (`src/lib/claudeMdGuard.test.ts`) enforces the 28 KB ceiling and
machine-checks that the index lists are complete — every script, every API route
— because an index nobody can trust is worse than none: the reader cannot tell
"not listed" from "does not exist".

**What goes here** — only what helps a reader FIND something, or avoid BREAKING
something in the next five minutes:

- **Added/removed an API route, Penny tool, repo, table, script or e2e spec** →
  update that index list. Mandatory and machine-checked.
- **Added a page or major component** → one line in the tree; **changed the
  stack** → one line in Stack.
- **A new invariant someone could break today** → one sentence, plus a link.

**What does NOT go here:** everything else — why a decision was made, what a
wrong belief cost, postmortems, measurements, migration narratives. That is the
most valuable text in the repo and it belongs in `docs/`, in the topic file for
that area. **Write the prose there first, then add at most one sentence here
pointing at it.** If you are adding a paragraph, you are in the wrong file.

This file was 225 KB on 2026-09-20 — nearly tripled in sixteen days, because the
old version of this section said what to update and never what not to put here.
If a change pushes it over 28 KB, move prose out. Raise the number only for
content the guard itself compels — an index entry, never a paragraph.

Every section above links its own file, all under `docs/design/` — except
`docs/decisions.md`, the decision register and guard-test registry.
