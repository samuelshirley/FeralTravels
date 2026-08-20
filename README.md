# Feral Travels

AI trip planner for overlanders. You tell **Penny** (a Claude tool-use agent) where you're going and how far you want to drive each day; she builds a dated, day-by-day itinerary with routes and rest days, and **Finn** (a deterministic fuel engine) finds gas stations your vehicle can actually reach along each day's route. You then edit the plan entirely by chatting — the itinerary list and map are read views anchored to your live GPS position.

Live at [feraltravels.com](https://www.feraltravels.com) (web + PWA). A native iOS client lives in [`mobile/`](mobile/) (Expo / React Native, TestFlight).

> **Deep reference:** [`CLAUDE.md`](CLAUDE.md) is the authoritative map of the codebase — architecture, schema, Penny tools, invariants, and the history behind every non-obvious decision. This README is the short version.

## What it does (MVP scope)

- **Chat-first planning.** Deterministic onboarding (vehicle name + comfortable / hard-max fuel range) runs *before* any LLM call. Then one sentence — "Girona to Lisbon, 3 days in Porto, 3 in Lisbon, 5 h driving max" — becomes a full multi-day plan in one turn.
- **Two stop types only.** `fuel` (found automatically by Finn) and `other` (a place the user adds by pasting a Google/Apple Maps link, an address, or a place name). Penny does not discover campgrounds, groceries, etc.
- **Fuel that respects physics.** Finn never routes a dry stretch past `hard_max_range_km`, aims for `comfortable_range_km`, carries tank state across days, and attaches a one-line reason to every forced stop. Fuel is sourced lazily when a day is opened and cached 48 h.
- **Adaptive on the road.** `report_position` re-anchors the trip to where the driver actually is; `declare_fuel_state` records "I only have 150 km in the tank"; the itinerary collapses days behind you.
- **Admin dashboard** at `/admin` (hardcoded allowlist): users, trips, chat volume, per-request AI cost, Google usage.

## Stack

| Layer | Choice |
|---|---|
| Web | Next.js 14 (App Router), React 18, TypeScript, CSS Modules, PWA service worker |
| iOS | Expo SDK 54 / React Native, expo-router, react-native-maps — pure client of the same API (`mobile/`) |
| API | 43 REST routes; every route accepts one Zod-validated payload; all DB access through `src/server/repos/*` |
| DB | Neon Postgres via Drizzle ORM (24 tables, migrations in `drizzle/`) |
| Auth | NextAuth v5 — email OTP + Google OAuth; mobile uses the same OTP flow and gets a bearer token stored in the iOS Keychain |
| AI | Anthropic SDK, tool use, 21 Penny tools in `src/lib/penny/tools/`; model IDs in `src/lib/models.ts` |
| Maps | Google Maps Platform — **one key** (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) for the browser SDK, server Directions, and Places (New) search-along-route / text search |
| Email | Resend |
| Tests | Vitest (unit, ~500 tests), Playwright (e2e) |
| Hosting | Vercel + Neon branches; GitHub Actions CI — merge to `main` deploys |

## Quick start

```bash
npm install
cp .env.example .env     # fill in the vars below
npm run db:migrate       # apply Drizzle migrations to your Neon DB
npm run dev              # http://localhost:3000
```

Required env (see `.env.example` for comments):

```
DATABASE_URL                     Neon pooled connection string
AUTH_SECRET                      openssl rand -base64 32
AUTH_URL                         http://localhost:3000 locally
AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET
AUTH_RESEND_KEY / AUTH_EMAIL_FROM
ANTHROPIC_API_KEY
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY  enable Maps JS, Directions, and "Places API (New)" on it
```

Optional: `ADMIN_EMAILS` (can only *restrict* the hardcoded allowlist), `REPLAN_REQUESTS_PER_HOUR`, `REPLAN_USD_CAP_PER_DAY`, `E2E_INBOX_DOMAIN` (the one e2e spec that reads a real inbox).

## Commands

```bash
npm run dev            # dev server
npm run build          # production build
npm run test           # vitest unit tests — run after EVERY code change
npm run e2e            # playwright (starts the app itself; see e2e/TESTING-MODES.md)
npm run e2e:smoke      # critical subset
npm run db:generate    # generate a migration from schema.ts
npm run db:migrate     # apply migrations
npm run db:studio      # Drizzle Studio
```

Schema change workflow: edit `src/server/db/schema.ts` → `npm run db:generate` → `npm run db:migrate`. Keep migrations additive.

## Architecture (short)

```
src/
  app/            pages (trips, trips/[tripId], login, settings, vehicle-setup, admin) + api/ routes
  components/     TripWorkspace pieces: ChatPanel, Itinerary/LegCard, TripMap, StopsSection, DeviceLocationContext …
  lib/
    penny/        Penny context, schedule/continuity repair, contiguity gate, leg placement, tool registry
    finn/         fuel engine: range math, route projection, station filter, greedy placement
    google/       server-side Directions, Places (search-along-route), geocode
    claude.ts     Penny system prompt + turn loop
  server/
    onboarding.ts deterministic form-in-chat state machine (runs before the LLM)
    fuel.ts       lazy per-leg fuel sourcing + cache + Finn wiring
    repos/        the only place SQL happens
    auth/         NextAuth config, guards (cookie + bearer), admin allowlist, OTP
    db/           schema.ts + Neon client
drizzle/          generated migrations
e2e/              Playwright specs + fixtures (real OTP sign-in, no auth bypass)
mobile/           Expo iOS app (shares DOM-free logic via mobile/shared, regenerated by npm run sync:shared)
```

### The three invariants (don't loosen)

1. **Endpoints are locked down.** One Zod payload per route; free-text interpretation lives only at the boundary that owns it (onboarding).
2. **The DB is locked down.** All access via repos; stored values are machine values, never raw human text.
3. **The LLM converts, it doesn't author.** Every model output is a forced tool schema, re-validated server-side. Penny may not invent coordinates (only `resolve_place`), plan numbers (derived from the DB), or fuel-range safety numbers (Settings only).

## Penny turn resilience

Every chat turn is a durable `penny_turns` row with an idempotency key. A partial unique index enforces one running turn per trip at the DB level; extra sends queue and drain in-request. A phone that backgrounds mid-stream re-attaches to the durable record instead of showing a false "something went wrong". See `docs/design/penny-turn-resilience.md`.

## Deploying

**Production has real users. Never run tests, seeds, or migrations against prod from a laptop.**

**Merging is deploying.** `main` is protected and only moves via pull requests; a merged PR is live on production a few minutes later. There is no ship script and no button to press.

1. **Open a PR into `main`** → GitHub Actions `CI` (`.github/workflows/ci.yml`), re-run on every push to the PR:
   - **Unit tests** — the full Vitest suite (logic specs in node, component specs under jsdom).
   - **Deploy tested preview** — creates an ephemeral Neon branch `preview/pr-<N>` (copy-on-write clone of prod data), migrates it, and deploys a Vercel preview pointed at it. The URL is posted as a sticky PR comment and pinned to the top of the PR description. Prod's DB is never touched, and this run is the rehearsal for the prod migration.
   - **E2E tests** — the full Playwright suite against that exact preview URL, plus a guard that fails the job if the suite mass-skipped. No auth bypass exists: specs sign in through the real OTP flow, and one spec sends a real email and reads it back. `/api/test/*` fixture endpoints are data-only, hard-off on production, and locked with a per-run HMAC secret.

   Those three are the **required checks** in branch protection. Also turn on *"require branches to be up to date before merging"* — without it, a PR tested against a stale `main` can ship on merge.
2. **Merge the PR** → `.github/workflows/deploy-production.yml` fires automatically on the push to `main`: it re-checks that the PR behind the merge commit had a green CI run, applies pending migrations to the prod DB, then builds and deploys that commit. Vercel's own git auto-deploy is disabled in `vercel.json`, so this workflow is the only path to prod.
3. **PR closes** → `.github/workflows/pr-cleanup.yml` deletes the PR's Neon branch, so a clone of real user data isn't left behind a public URL.

A direct push to `main` has no CI run behind it, so the deploy refuses it — push through a PR.

**Rolling back:** merge a revert PR (it goes through the same gate), or, for an instant fix, re-promote the previous production deployment from the Vercel dashboard. Neither undoes a migration — which is why migrations stay additive (add → backfill → switch code → drop later).

## iOS app

See [`mobile/README.md`](mobile/README.md) and [`docs/design/ios-app-plan.md`](docs/design/ios-app-plan.md). Bundle `com.feraltravels.app`; EAS build profiles `development` / `preview` / `production`; `eas submit` → TestFlight. Sign in with Apple is env-gated (`EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1`). Paywall (StoreKit 2 via RevenueCat) is designed but sequenced after TestFlight.

## Docs worth reading

- `docs/design/finn-fuel-agent.md` — Finn design + Google-only cutover
- `docs/design/penny-turn-resilience.md` — durable turns / idempotency
- `docs/plans/google-only-teardown.md` — why OSM/OSRM and fuel pricing were removed
- `docs/mvp-cleanup/` — the scope-down that defined the MVP
