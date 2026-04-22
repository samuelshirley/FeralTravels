# Trip Planner

Map-first overlanding trip planner with chat-based AI replanning ("Penny"). Built with Next.js (App Router), Drizzle ORM + Postgres (Neon), Auth.js, Google Maps, and Anthropic Claude.

Headline features:

- **Triple-pane workspace** (map · itinerary · chat) with drag-resizable panes on desktop and a sticky bottom nav on mobile. Pull-to-refresh on the trips list and trip workspace.
- **Chat-based onboarding** — new trips walk the user through a deterministic form-in-chat (vehicle pick or create, drive/water/fuel prefs, destination) before Penny goes live. State machine persisted on the trip row (`not_started → vehicle_pick|vehicle_new → ready → done`).
- **Penny**, a Claude-powered planner that emits structured JSON change actions and respects per-trip **vehicle constraints** (drive limits, height, water cadence, fuel range). Locked to trip-scoped conversations — off-topic turns get politely redirected, no JSON emitted.
- **Routes per leg** with multiple options, surface badges, drive-time chips, GPX/Google Maps/Wikiloc/Komoot/Gaia link types, and a one-click **Pick this** that becomes the leg's selected stop.
- **Stops per leg** (fuel / overnight / water / food / rest) with Copy GPS buttons on each stop and "🐕 Dog parks nearby" / "🌳 Parks nearby" Google Maps search chips at the leg's end coords, plus a paste-GPS input that turns any lat/lng or Maps URL into a selected waypoint on the leg's one-click Google Maps route.
- **Automatic fuel-stop planning** — on leg creation (and on demand via `POST /api/legs/:id/fuel-stops`), samples the OSRM polyline at `range × SAMPLE_FRACTION` intervals and picks gas stations from Google Places Nearby Search. Effective range is `kmpl × tank_l × 0.8` (20% reserve). User-authored stops are never overwritten.
- **Google Maps "Go" links** that open turn-by-turn navigation directly (`dir_action=navigate`), not the preview.
- **Multi-trip / multi-vehicle** with per-trip vehicle picker in the navbar and a settings page for vehicle profiles.
- **Admin dashboard** at `/admin` with a hardcoded allowlist + DB flag + verified-email guard for cost/usage monitoring.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure environment
cp .env.example .env
# Fill in:
#   DATABASE_URL                    – Neon Postgres connection string (pooled)
#   AUTH_SECRET                     – openssl rand -base64 32
#   AUTH_URL                        – e.g. http://localhost:3000 (production: your domain)
#   AUTH_GOOGLE_ID / SECRET         – Google OAuth credentials
#   AUTH_RESEND_KEY                 – Resend API key (email magic links)
#   AUTH_EMAIL_FROM                 – verified sender (use a *.resend.dev subdomain
#                                      for dev; onboarding@resend.dev only sends to
#                                      the Resend account owner and will 500 for
#                                      anyone else)
#   ANTHROPIC_API_KEY               – Penny / chat replanning
#   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY – Maps JS + Directions (browser, referrer-locked)
#   ADMIN_EMAILS                    – optional whitelist subset (must already be in
#                                      the hardcoded ADMIN_ALLOWLIST in admin.ts)
#   REPLAN_REQUESTS_PER_HOUR        – per-user Penny rate limit (default 40)
#   REPLAN_USD_CAP_PER_DAY          – per-user Penny daily $ cap (default 5)

# 3. Initialize database
npm run db:migrate     # apply Drizzle migrations to Neon
npm run seed           # create the demo trip (Iberia → Nordkapp) as a public template

# 4. Run dev server
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login`. Sign in via Google or email magic link, then go to `/trips` to view/clone the demo or create your own.

## Database commands

```bash
npm run db:generate         # generate a new migration from the Drizzle schema
npm run db:migrate          # apply pending migrations
npm run db:push             # push schema directly (dev only — no migration history)
npm run db:studio           # open Drizzle Studio GUI
npm run seed                # rebuild the public demo trip
npm run migrate-sqlite      # one-time import from legacy SQLite db (see below)
npm run backfill-maps-nav   # rewrite legacy path-style Google Maps URLs to the
                            # API-style nav format so the "Go" pill works on mobile
```

## Migrating from the old SQLite version

If you previously ran the app with SQLite (default path `/tmp/trip-planner/trip.db`):

```bash
# Import the existing trip into Neon (defaults to the demo user, marks it as a template)
npm run migrate-sqlite

# Or import into your own user account (must already exist in the auth tables)
npm run migrate-sqlite -- --owner-email=you@example.com --sqlite=/tmp/trip-planner/trip.db
```

The script writes a marker into `app_meta` so re-running is a no-op. After a successful migration, you can `npm uninstall better-sqlite3 @types/better-sqlite3`.

## Architecture

- **Frontend**: Next.js 14 (App Router), React 18, `react-resizable-panels`. Responsive at three tiers: mobile (<768) with a sticky bottom nav (List · Map · Chat · Settings), tablet (768-1023) with a top nav and stacked panes, desktop (≥1024) with the drag-resizable triple-pane layout.
- **PWA**: `public/manifest.json` + `public/sw.js` (network-first for HTML, cache-first for `/_next/static`, stale-while-revalidate for the rest, no interception for `/api`). Auto-reloads when a new SW takes control, so deploys never get stuck on stale HTML.
- **Auth**: Auth.js v5 (NextAuth) with Google OAuth + Resend magic links, `@auth/drizzle-adapter`. Custom `sendVerificationRequest` renders a branded HTML email and surfaces send failures (e.g. wrong Resend sender) as user-friendly messages on `/login`.
- **Database**: Postgres via Neon, accessed through Drizzle ORM (`postgres-js` driver). Schema in `src/server/db/schema.ts`.
- **Map**: Google Maps JavaScript API (dark theme) with Directions API for road-following routes. The `lib/maps.ts` helpers always emit `?api=1&dir_action=navigate` URLs so "Go" links open turn-by-turn nav, not preview.
- **AI**: Anthropic Claude (Penny) for chat-based replanning with structured JSON change actions. Per-user rate + spend caps live in `src/app/api/trip/replan/route.ts`; usage is logged to `usage_events` and aggregated in the admin dashboard. A deterministic onboarding form-in-chat (`src/server/onboarding.ts`) runs before the first Anthropic call — `chat_history.kind` distinguishes `form_question`/`form_answer` rows from live `ai` turns so onboarding Q&A is never fed back into the model as conversation history.
- **Fuel planning**: `src/server/fuel.ts` samples the OSRM polyline for a leg and queries Google Places for gas stations. `legs.fuel_status` (`none|pending|computing|ready|failed`) lets the UI show a spinner / retry affordance without polling.
- **Stops**: `stops` table holds per-leg waypoints (fuel / overnight / water / food / rest / other). The leg card's Stops section surfaces a "🐕 Dog parks nearby" and "🌳 Parks nearby" Google Maps search centered on the leg's end coords (overnight spot discovery), a Copy GPS button on each stop (paste into any external spot-finder app), and a paste-GPS input that accepts raw lat/lng or Google/Apple Maps URLs (short links expanded via `POST /api/coords/parse`). Selected stops become waypoints in the leg's one "Open in Google Maps" button. Penny proposes fuel stops from the vehicle's effective range (`km/L × tank × 0.8`).
- **GPX overlays**: stored in `src/data/gpx/`, parsed via `@tmcw/togeojson`.
- **Routing**: `/trips` (list), `/trips/[tripId]` (single trip workspace), `/settings` (profile + vehicles + admin), `/admin` (cost & user dashboard, allowlist-gated), `/login`.

## Multi-user model

- Every `trip`, `leg`, `task`, `route`, `gpx_trail`, `poi`, `vehicle` is owned by a `user_id` (Auth.js `users.id`).
- API routes call `requireUserId()` and `assertTripOwnedByUser` / `assertTripReadableByUser` from `src/server/auth/guards.ts` before touching data.
- Trips with `is_template = true` are world-readable; only their owner can mutate them. Other users clone them via `POST /api/trips/[id]/clone`.
- Each new user gets a default `Vehicle` row created automatically (see `events.createUser` in `src/server/auth/index.ts`). Users manage additional vehicles in `/settings`; each trip can pick one via the chip in the navbar (`PATCH /api/trips/[id]` with `vehicle_id`). Selected (or default) vehicle constraints are injected into Penny's prompt as a `<vehicle_constraints>` block.

## Admin (defence in depth)

`/admin` requires **all** of:

1. The signed-in email is in the hardcoded `ADMIN_ALLOWLIST` (`src/server/auth/admin.ts`)
2. The optional `ADMIN_EMAILS` env var is unset OR contains the email (env can never *grant* admin, only *restrict* it further)
3. The `users.is_admin` DB flag is `true` for that user
4. `users.emailVerified` is not null (Google OAuth backfills this on sign-in)

Usage events for Anthropic are logged to `usage_events` so the admin dashboard can show per-user and per-provider cost.

## Project structure

```
src/
├── app/
│   ├── page.tsx                  redirect: → /login or /trips
│   ├── login/page.tsx            sign-in (Google + email magic link)
│   ├── trips/
│   │   ├── page.tsx              trip list (own + templates)
│   │   ├── NewTripButton.tsx
│   │   ├── CloneTripButton.tsx
│   │   └── [tripId]/
│   │       ├── page.tsx          server: load trip + auth check
│   │       └── TripWorkspace.tsx client: map | itinerary | chat layout
│   ├── settings/page.tsx         user profile + VehicleProfileSection + admin link
│   ├── admin/                    cost/user dashboard (allowlist-gated)
│   └── api/
│       ├── auth/[...nextauth]/   Auth.js handlers
│       ├── trips/                list / create / clone / delete (DELETE) /
│       │                         PATCH (rename, vehicle_id assignment);
│       │                         subroutes: [id]/clone, [id]/onboarding
│       ├── trip/                 get full trip, replan (POST → Penny)
│       ├── chat/                 cursor-paginated chat history (GET)
│       ├── vehicles/             CRUD + setDefault for user vehicles
│       ├── routes/               route options + links + select (POST)
│       ├── stops/                CRUD + select for per-leg stops
│       ├── legs/[id]/fuel-stops/ trigger auto fuel-stop planning for a leg
│       ├── coords/parse/         expand short Maps links / parse spot URLs
│       ├── tasks/                Penny + user tasks
│       ├── gpx/                  upload, fetch as GeoJSON
│       ├── pois/                 POI lookup
│       ├── directions/           OSRM fallback
│       └── admin/test-error/     smoke test for error tracking
├── components/                   UI: TripMap, Itinerary, LegCard,
│                                 RoutesSection, StopsSection, TasksSection,
│                                 ChatPanel, ChatDrawer, ChatToggleButton,
│                                 OnboardingForm, AppNavbar, BottomNav,
│                                 PullToRefresh, StatusBadge, Spinner,
│                                 ErrorNotifier, VehicleProfileSection,
│                                 TripVehicleChip
├── lib/
│   ├── api.ts                    client-side `tripApi(tripId)` factory
│   ├── claude.ts                 Anthropic + Penny system prompt + vehicle
│   │                             context injection + trip-only topic lock
│   ├── coords.ts                 Parse lat/lng, DMS, and Google Maps URLs
│   ├── maps.ts                   Google Maps URL helpers (buildNavUrl,
│   │                             buildLegDirectionsUrl, rewriteMapsUrlForNav)
│   ├── polyline.ts               Encoded polyline decode + length +
│   │                             every-N-km sampling (used by fuel planner)
│   ├── penny/context.ts          Build Penny's trip/vehicle/stops context
│   │                             (also exports computeEffectiveRangeKm)
│   ├── directions.ts             OSRM client
│   ├── gpx.ts                    GPX file IO + GeoJSON parsing
│   ├── useMediaQuery.ts          responsive-layout hook
│   └── sillyErrors.ts            friendly copy for known failure modes
├── server/
│   ├── auth/                     Auth.js config + ownership + admin guards
│   ├── db/                       Drizzle schema + client singleton
│   ├── onboarding.ts             deterministic form-in-chat state machine
│   ├── fuel.ts                   OSRM + Google Places auto fuel-stop planner
│   └── repos/                    typed data-access layer (trips, routes,
│                                 stops, tasks, gpx, pois, vehicles, chat,
│                                 usage, admin)
├── data/
│   ├── demo-trip.ts              seed data for the public demo
│   └── gpx/                      uploaded .gpx files
└── types/trip.ts                 shared TypeScript types
```

## Phone access (PWA)

```bash
ngrok http 3000
# Open the ngrok URL on your phone, Safari → Share → Add to Home Screen.
```

The service worker is `network-first` for HTML, so a deploy is picked up on the next page load and the page auto-reloads when the new SW takes control. If a phone gets stuck on a stale build, opening DevTools → Application → Service Workers → "Update on reload" usually unblocks it.

## Deploying to Vercel

1. Connect the GitHub repo. Vercel auto-detects Next.js.
2. In the project settings, set every env var listed above. Notably `AUTH_URL` must be the canonical production URL (e.g. `https://trip-planner.vercel.app`) and `AUTH_TRUST_HOST=true`.
3. Add the production callback to Google OAuth (`https://<your-domain>/api/auth/callback/google`).
4. After the first deploy, run `npm run db:push` against your Neon prod URL to apply any new schema columns (or set up `db:migrate` in CI). The stops + vehicles + admin tables are required.
5. If you have legacy Google Maps links in routes that were built before the URL rewriter shipped, run `npm run backfill-maps-nav` once to upgrade them to the API-style nav format.
