# Trip Planner

Map-first overlanding trip planner with chat-based AI replanning ("Penny"). Built with Next.js (App Router), Drizzle ORM + Postgres (Neon), Auth.js, Google Maps, and Anthropic Claude.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure environment
cp .env.example .env
# Fill in:
#   DATABASE_URL                   – Neon Postgres connection string (pooled)
#   AUTH_SECRET                    – openssl rand -base64 32
#   AUTH_GOOGLE_ID / SECRET        – Google OAuth credentials
#   AUTH_RESEND_KEY                – Resend API key (for email magic links)
#   AUTH_EMAIL_FROM                – verified sender (or onboarding@resend.dev for dev)
#   ANTHROPIC_API_KEY              – Penny / chat replanning
#   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY – Maps JS + Directions

# 3. Initialize database
npm run db:migrate     # apply Drizzle migrations to Neon
npm run seed           # create the demo trip (Iberia → Nordkapp) as a public template

# 4. Run dev server
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/login`. Sign in via Google or email magic link, then go to `/trips` to view/clone the demo or create your own.

## Database commands

```bash
npm run db:generate     # generate a new migration from the Drizzle schema
npm run db:migrate      # apply pending migrations
npm run db:push         # push schema directly (dev only — no migration history)
npm run db:studio       # open Drizzle Studio GUI
npm run seed            # rebuild the public demo trip
npm run migrate-sqlite  # one-time import from legacy SQLite db (see below)
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

- **Frontend**: Next.js 14 (App Router), React 18, `react-resizable-panels`
- **Auth**: Auth.js v5 (NextAuth) with Google OAuth + Resend magic links, `@auth/drizzle-adapter`
- **Database**: Postgres via Neon, accessed through Drizzle ORM (`postgres-js` driver)
- **Map**: Google Maps JavaScript API (dark theme) with Directions API for road-following routes
- **AI**: Anthropic Claude (Penny) for chat-based replanning with structured JSON change actions
- **GPX overlays**: stored in `src/data/gpx/`, parsed via `@tmcw/togeojson`
- **Routing**: `/trips` (list), `/trips/[tripId]` (single trip workspace), `/login`

## Multi-user model

- Every `trip`, `leg`, `task`, `route`, `gpx_trail`, `poi`, `vehicle` is owned by a `user_id` (Auth.js `users.id`).
- API routes call `requireUserId()` and `assertTripOwnedByUser` / `assertTripReadableByUser` from `src/server/auth/guards.ts` before touching data.
- Trips with `is_template = true` are world-readable; only their owner can mutate them. Other users clone them via `POST /api/trips/[id]/clone`.
- Each new user gets a default `Vehicle` row created automatically (see `events.createUser` in `src/server/auth/index.ts`). Vehicle constraints feed into Penny's planning prompts (Phase 2b).

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
│   └── api/
│       ├── auth/[...nextauth]/   Auth.js handlers
│       ├── trips/                list / create / clone
│       ├── trip/                 get full trip, replan (POST → Penny)
│       ├── routes/               route options + links
│       ├── tasks/                Penny + user tasks
│       ├── gpx/                  upload, fetch as GeoJSON
│       ├── pois/                 Park4Night / iOverlander overlays
│       └── directions/           OSRM fallback
├── components/                   UI: TripMap, Itinerary, LegCard,
│                                 RoutesSection, TasksSection, ChatPanel,
│                                 AppNavbar, StatusBadge
├── lib/
│   ├── api.ts                    client-side `tripApi(tripId)` factory
│   ├── claude.ts                 Anthropic + Penny system prompt
│   ├── directions.ts             OSRM client
│   └── gpx.ts                    GPX file IO + GeoJSON parsing
├── server/
│   ├── auth/                     Auth.js config + ownership guards
│   ├── db/                       Drizzle schema + client singleton
│   └── repos/                    typed data-access layer (trips, routes,
│                                 tasks, gpx, pois, vehicles, chat)
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
