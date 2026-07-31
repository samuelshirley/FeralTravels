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
- **Maps:** Google Maps (client JS API + server Directions API for routes + Places `fuelOptions` as a per-station price fallback in `lib/fuelPricing/providers/google.ts` + **Places API (New) `places:searchText`** for name→coords resolution in `lib/google/geocode.ts`). NOTE (2026-07-01): `geocode.ts` uses **Places API (New) only** — the legacy `place/textsearch/json` endpoint and the `geocode/json` Geocoding-API fallback were removed. The legacy endpoint required the deprecated "Places API" SKU (not enabled on the one key) and caused a 100% `REQUEST_DENIED` outage; there is now a single `searchText` call and no cross-product fallback (a miss returns `not_found`/`unavailable`, and the caller asks for a Maps link). **Fuel stations are NOT from Google** — Finn sources them from OSM Overpass; route geometry for fuel planning is OSRM (`lib/directions.ts`, free, no key). NOTE (2026-07-01): the Overpass client (`lib/osm/overpass.ts`) MUST send an identifying `User-Agent` (`OVERPASS_USER_AGENT`) — overpass-api.de rejects UA-less requests with HTTP 406 (this was the `finn:fuel-plan` prod outage). NOTE (2026-07-02): Overpass can also SOFT-fail — HTTP 200 with a `remark` ("runtime error: Query timed out") and empty/truncated `elements`; the client now throws on any `remark`, and `server/fuel.ts` treats a needed-stop-but-zero-candidates gap as retryable `failed`, never the 48h-cached `no_stations_found` warning (reserved for "stations exist but none reachable before the hard ceiling"). The Place Photos / Street View "stop photos" feature was **removed 2026-06-30** (see teardown note below).
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

**Production has real users.** Prod is live — do NOT run tests or seed fixtures against the prod database, and treat prod deploys as consequential.

Deploy pipeline (single branch `main`, no long-lived staging):

1. **Push to `main`** → GitHub Actions `CI` workflow (`.github/workflows/deploy.yml`): unit tests → **deploy ONE tested Vercel preview** (pointed at the rolling `preview` Neon branch, a copy-on-write clone of prod data refreshed each push, migrated before deploy) → **E2E runs against that exact preview URL** (`E2E_BASE_URL`; playwright.config skips its local webServer). The same URL is printed to the run summary for eyeballing — it deploys *before* tests so a red spec still leaves you a clickable preview to distinguish test bugs from app bugs. Playwright artifacts (report/traces) upload on failure. E2E never touches prod. Green = the commit is promotable.
2. **Ship** → run the **"Promote to production"** workflow (`.github/workflows/promote.yml`) manually from the Actions tab ("Run workflow"). Its first step **enforces the gate**: it queries the CI runs for the exact SHA being promoted and fails unless the latest is completed+green. Then it applies migrations to prod and builds + deploys that commit to production via the Vercel CLI.

Vercel's own git auto-deploy for `main` is **disabled** in `vercel.json` (`git.deploymentEnabled.main = false`), so the promote workflow is the ONLY path to prod — nothing reaches production without a manual button press, and the button refuses red commits.

**E2E auth: NO bypass exists (removed 2026-07-02).** Every authenticated spec creates a fresh MailSlurp inbox and signs in through the REAL OTP email flow (`createFreshUser()`/`loginViaOtp()` in `e2e/fixtures/auth.ts`; `MAILSLURP_API_KEY` required — authenticated specs skip without it, and the target app needs a working Resend key to actually send the code). The old `AUTH_TEST_BACKDOOR` family — login-page test sign-in, the Credentials provider, `/api/test/session` session minting — is deleted, and `src/lib/noBackdoorGuard.test.ts` fails the unit suite if anything resembling it (`/backdoor/i`, `createTestSession`, a Credentials provider) reappears in `src/`. E2E fixtures (DATA only: seed/trip/cleanup/announcement) run over HTTP against the guarded `/api/test/*` endpoints — no raw SQL in specs. Those endpoints are gated by `E2E_TEST_ENDPOINTS=1` (`areTestEndpointsEnabled` in `auth/test-endpoints.ts`) and are **hard-off on `VERCEL_ENV=production` with no override env** (unit-enforced in `test-endpoints.test.ts`). **Because the tested preview is internet-reachable, the endpoints are additionally locked by a per-run secret** (`E2E_TEST_ENDPOINTS_SECRET`, required in the `x-e2e-test-secret` header when set): CI derives it as HMAC(AUTH_SECRET, run id) identically in the preview + e2e jobs (nothing passed through job outputs), the runner sends it via `testEndpointHeaders()` (`e2e/fixtures/constants.ts`) + the config `extraHTTPHeaders`. Locally the secret is unset and nothing changes. Optional `VERCEL_AUTOMATION_BYPASS_SECRET` is wired through the same headers if Vercel Deployment Protection ever gets enabled. App runtime/build env for the preview (Anthropic, Resend, Maps keys) comes from the Vercel project's **preview environment** via `vercel pull` — keep it complete there. `scripts/ship.sh` is legacy (it pushed straight to the old auto-promote flow); prefer the CI + promote-button path.

E2E cross-spec state: none — each test gets a fresh MailSlurp user and seeds its own canonical graph (`seedCanonicalFixture(email)` in `e2e/fixtures/test-trip.ts`), so specs can't contaminate each other. Cost of the model: ~1 MailSlurp inbox + 1 real Resend OTP send + ~5–10s per authenticated test; if MailSlurp quota becomes a problem, the documented fallback is one fresh user per RUN signed in once in global-setup with a shared Playwright `storageState`.

Division of labor:

- **Claude commits** finished work (after `tsc --noEmit` + `npm run test` pass); **Sam pushes** and runs the promote button.

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
    TripMap.tsx       # Google Maps view. Renders per-leg route polylines, leg-start + final-destination markers, AND stop markers (fuel = gold square, user-added 'other' = slate square) flattened from `legs[].stops`. Stops are clustered in SCREEN SPACE via `lib/mapClustering` (re-runs on map 'idle'); a count bubble expands (fitBounds) on click. Desktop hover (matchMedia '(hover: hover)') shows a stop tooltip; click a stop OR leg marker fires `onStopSelect`/`onLegSelect` → parent opens it in the list (TripWorkspace `focusInList`). Stops are LAZY (option B): only days already opened in the list have stops in the data, so a never-browsed trip shows a quiet "Open a day to load its fuel stops" hint instead of an empty map. No new npm dep — clustering is the in-repo grid clusterer, deliberately NOT @googlemaps/markerclusterer (avoids mutating macOS node_modules from the Linux build sandbox).
    Itinerary.tsx     # Leg/stop/route display. `focusTarget` ({legId, stopId, nonce}) from a map marker click expands the owning leg (revealing it past the lazy window / "behind you" fold), scrolls the leg ([data-leg-id]) or exact stop ([data-stop-anchor]) into view, and briefly rings the stop (highlightStopId → LegCard → StopsSection).
    TasksSection.tsx  # Trip tasks
    DeviceLocationContext.tsx  # THE client GPS pipeline (2026-07-12): owns the one on-load location prompt, a live watchPosition, and a Permissions-API onchange subscription (grant-after-mount activates consumers live). TripWorkspace's position report + useNextStop (smart nav) consume it; nothing else may call the Geolocation API.
    stops/            # StopCard, StopsSection, MoreStopsModal (with tests)
    AnnouncementModal.tsx  # One-time announcement popup
    (+ AppNavbar, BottomNav, MobileFooter, Spinner, StatusBadge, etc.)
  lib/
    api.ts            # Client-side API helper
    models.ts         # Central registry of hardcoded Anthropic model IDs (PENNY_MODEL, DATE_PARSE_MODEL, RANGE_ESTIMATE_MODEL, ONBOARDING_SCAN_MODEL)
    coords.ts         # Coordinate parsing/formatting (sync; Google/Apple Maps URLs, lat/lng)
    coordsResolve.ts  # Server-side Maps URL resolution (short-link redirects; scans page body for !3d!4d/@lat,lng; extracts the embedded google.com/maps?q=<addr> link and geocodes it; og:title place name as a last resort); used by api/coords/parse and Penny chat enrichment. NOTE (2026-07-01): short links MUST be fetched with a CRAWLER User-Agent (`SHORT_LINK_USER_AGENT` = facebookexternalhit) — a browser UA gets maps.app.goo.gl's JS-only interstitial with no coords/name/og-tags (the "links won't resolve" bug); the crawler UA is what makes Google embed the destination `?q=<address>` link that `extractEmbeddedMapsQuery` reads. Do NOT switch to a browser-like UA.
    google/geocode.ts # Deterministic name/address/city → coords (Places Text Search → Geocoding fallback). Tri-state result w/ granularity. Backs the resolve_place Penny tool; the ONLY name→coords path (no LLM coordinate guessing)
    maps.ts           # Google Maps client helpers
    reverseGeocode.ts # Best-effort client coords→place label via the Maps JS Geocoder (importLibrary('geocoding')); forgiving (any failure → null). Feeds the device-location place name posted from TripWorkspace on app open.
    mapClustering.ts  # Pure screen-space grid clusterer (clusterPixels) for TripMap stop markers — dependency-free stand-in for @googlemaps/markerclusterer. Unit-tested.
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
    fuelPricing/      # Region-pluggable price layer (tri-state PriceResult). See finn-fuel-agent.md
      coverage.ts     # Static country capability map (feed vs no-price countries)
      coordinator.ts  # Runs providers (bulk feeds → per-station Google) → PriceResult per station
      providers/      # tankerkoenig.ts (DE feed, bulk) + google.ts (fuelOptions, per-station fallback)
    penny/
      context.ts      # Builds context for Penny from trip data
      geo.ts          # Geo utilities for Penny
      schedule.ts     # Deterministic rest-day/leg-order materializer + route-continuity fixes (computeStartFixes — every leg must start where the previous ended); pure. Applied by trips.repairLegContinuity
      fuelTankState.ts # Pure continuous-drive tank math (km burned since last refuel); only actual fuel stops/trip start refill — rest days & overnights are NOT implicit refuels. DB shim: server/fuel.ts
      planSummary.ts  # Deterministic DB-derived plan facts (day counts, dates, totals, ETA via dayModel, deadline check) — source of truth for plan numbers shown to the user; Penny's prose must NOT state them
      sanitize.ts     # Strips/ detects tool-call markup leaked into Penny's text (she must emit prose only, never <invoke>/<parameter> XML)
      autoContinue.ts # Pure helper for server-side auto-continue: appends a continuation nudge to the message list without breaking user/assistant alternation when a planning turn truncates (used by claude.ts loop)
      contiguityGate.ts # Pure pre-dispatch delete_leg gate (extracted from the replan route 2026-07-02): simulates the turn's actions and blocks only deletes that create a NEW >50km gap relative to the trip's CURRENT gap baseline. The old inline version compared against "zero gaps", so one pre-existing gap anywhere made EVERY delete permanently blocked — the "delete all stops after Tromsø" incident: 36/36 deletes rejected while Penny's already-streamed prose claimed success. Suffix/prefix (tail/head) deletes can never create a gap and now always pass. Unit-tested.
      legPlacement.ts # Pure add_leg placement inference (2026-07-02): when Penny passes no after_leg_id/sort_order, addLeg (repos/trips.ts) inserts the new leg right after the LAST existing leg whose END is within 50km of the new leg's START, instead of blindly appending at max+1. Fixes the batch-insert bug where legs 2..N of a multi-add stretch (only the first carried after_leg_id) landed after the trip's final leg and continuity repair then manufactured a 3,383km "driving day". Explicit placement always wins; no coord match still appends (so sequential trip building is unchanged). Unit-tested.
      editOverride.ts # Pure post-pipeline tripwire (2026-07-03): after rebuild+repair settle, compares each applied update_leg's WHERE fields (title/names/coords, ~11m coord epsilon) against the persisted rows. A mismatch = the pipeline overrode an edit Penny's already-streamed prose describes. The replan route logs it (`penny:edit-overridden`, success=false → /admin/errors) and ships `overriddenEdits` in the applied payload; deriveApplyOutcome folds it into partialApplyWarning (no ChatPanel change — live + heal paths both get it). Metrics (distance/time) deliberately unchecked — re-routing recomputes them legitimately. Unit-tested (editOverride.test.ts).
      split-route.ts  # Route splitting logic
      routingAvoidMerge.ts  # Avoid-highway merge logic
      tools/          # 21 Penny tools (see Penny Tools below)
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
      test-endpoints.ts # Guard for /api/test/* fixture-DATA endpoints (hard-off on prod; NO auth bypass exists)
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
api/trips/[id]/onboarding api/trips/[id]/position
api/trips/[id]/turns
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
api/me                    api/me/preferences
api/mobile/otp/send       api/mobile/otp/verify
api/support               api/analytics/viewport-time
api/analytics/client-error
api/admin/test-error      api/admin/announcements
api/announcements/active  api/announcements/dismiss
api/debug/fuel
api/test/seed             api/test/trip
api/test/cleanup          api/test/announcement
```

**`api/test/*` are TEST-ONLY and DATA-ONLY** — guarded by `isTestRequestAuthorized()` (`auth/test-endpoints.ts`; return 404 otherwise), hard-off on Vercel production with no override. They let the E2E suite create/reset fixture DATA over HTTP (no direct DB). They can NOT mint sessions or bypass sign-in — e2e signs in via the real OTP email (MailSlurp). Backed by `repos/testSupport.ts`.

### Schema (24 tables in `src/server/db/schema.ts`)

users, accounts, sessions, verificationTokens, emailOtpCodes, vehicles, trips, legs, legConstraints, costs, pois, links, gpxTrails, routes, routeLinks, stops, tasks, chatHistory, appMeta, usageEvents, userViewportTime, announcements, announcementDismissals, pennyTurns

**Penny turn resilience — `pennyTurns` (migration 0018, 2026-06-30):** one durable row per Penny replan turn, independent of the SSE stream the client reads. Fixes the "Something went wrong. Please try again." false-failure bug: that bubble is a **client-only** `catch` in `ChatPanel.tsx` (the PWA backgrounded mid-turn tears down the fetch and `reader.read()` throws); the server keeps running and persists Penny's reply regardless (Vercel request cancellation is opt-in via a `vercel.json` `supportsCancellation` flag — there is **no `vercel.json`**, so it's off and turns are not lost). `pennyTurns` lets a dropped client **re-attach/reconcile** (heal the false error) instead of dead-ending, gives the server an **idempotency** anchor (`idempotency_key` unique — a retry/double-send can't spawn two concurrent replans), and persists a **`queued`** turn so a send fired while another is in flight survives the app closing and runs after (drained by the finishing invocation). Status: `queued | running | done | error`. Diagnostics for client-only stream failures go to `usage_events` (`provider = 'penny:client-stream-error'`) via `POST /api/analytics/client-error`. See `docs/design/penny-turn-resilience.md`. **Build status (FULLY WIRED 2026-06-30):** schema + repo + #1 diagnostics + the full #2–#4 wiring are done. `POST /api/trip/replan` now creates a turn (idempotent on `idempotency_key`), runs it via the extracted `runTurnWork`, marks it `done`/`error` on the row, and after the foreground turn finishes **drains any `queued` turns inside the same still-alive request** (`drainQueuedTurns`, atomic `claimNextQueuedTurn`, capped at `MAX_DRAIN_TURNS=5`) — chosen over `unstable_after`, which isn't available in Next 14.2.35. A turn that queues behind an in-flight one returns JSON (`{ turn }`) instead of an SSE stream; an idempotent replay returns the existing row. New `GET /api/trips/[id]/turns?key=` (reconcile/poll endpoint, read-only). Client (`ChatPanel.tsx`): each send carries an `idempotencyKey` (stored as `turnKey` on the assistant bubble), handles the JSON-vs-stream branch, and **heals the false error bubble** by reconciling the durable record on stream-throw, on stream-incomplete, and on `visibilitychange`/`focus` (re-attach on reopen). Apply logic is the pure `deriveApplyOutcome` (`src/lib/penny/applyOutcome.ts`, unit-tested), shared by the live-stream and heal paths. **Concurrency model (migration 0019, 2026-06-30):** every send is inserted as a `queued` turn (`createTurn`, deduped on `idempotency_key`) and then tries to claim the trip's single execution slot via `promoteTurnToRunning`. A **partial unique index** `penny_turns_one_running_per_trip_idx` (`UNIQUE (trip_id) WHERE status = 'running'`, migration 0019) makes the claim **atomic and DB-enforced**: a second concurrent send's promotion raises a unique violation, caught in the repo (`isUniqueViolation`/`23505`) → returns null → the turn stays `queued` and is drained by the running request. `claimNextQueuedTurn` (drain) routes through the same promotion, so two concurrent drains can never put two turns `running`. This closes the check-then-insert TOCTOU — **two distinct concurrent sends can no longer both start a replan on one trip** (queued backlog of N is still allowed; the index only constrains `running`). **Apply migration 0019 with `db:migrate`.**

**Residual notes / known gaps (reviewed):** (1) **Idempotency-key dedup is fully enforced** (unique index on `idempotency_key`) — a retry/double-send of the SAME turn (the "Please try again" button, the common cause) cannot spawn a second replan. (2) **One-running-per-trip is now DB-enforced** (see Concurrency model above) — the prior TOCTOU is closed. (3) Queued turns drain **in-request** (not a background job): if the foreground invocation is *killed* between `markTurnDone` and `drainQueuedTurns`, a turn queued behind it can sit `queued` until the client's poll deadline (~5min, then a "reopen in a moment" notice) — a *subsequent* send self-heals it (it promotes itself and its drain picks up the backlog). A background sweeper would fully close this; deferred. (4) Retention/pruning of `penny_turns` rows is unaddressed (transient diagnostics-grade).

`trips` carries a driver-progress anchor (`current_leg_id`, `current_lat/lng`, `progress_anchor_date`, `progress_updated_at`) set by the `reportPosition` tool; `getTripFull` re-anchors every leg's `date_iso` from it, and the itinerary collapses legs before `current_leg_id` as "behind you". An explicit report is a **floor**, not a freeze — `behindCutoffRank` (`src/lib/dates.ts`) takes the max of the report and the calendar, so a stale report no longer pins the view (the days-old "frozen itinerary" bug).

**User timezone — "today" is the driver's wall clock, not the server's (migration 0017, 2026-06-30):** new nullable `users.timezone` (IANA string, e.g. `"Europe/Oslo"`) is captured from the browser on load via `Intl.DateTimeFormat().resolvedOptions().timeZone` (no geolocation permission — distinct from GPS) and PATCHed to `/api/me/preferences` by `UnitsContext` (once per page-load). It's the single source of truth for the user's current day. Server "today" now resolves through `todayISOInZone(tz)` (`src/lib/dates.ts`, UTC-fallback when null/invalid) everywhere it used to call `todayISO()` for trip logic: leg-date anchoring in `getTripFull`, Penny's `context.today`, and the `report_position` anchor (`applyTripProgress`). **Bug it fixes:** the server runs in UTC on Vercel while the client collapses days in browser-local time, so a UTC-stamped anchor vs a local cutoff drifted a day near midnight and showed the day-you're-on as "behind you / completed". The client cutoff still uses browser-local `todayISO()` (already the user's zone). Repo helpers: `getUserTimezone`/`setUserTimezone` (`repos/users.ts`, re-validates the zone against Intl before persisting). The "behind you" header now reads "N earlier days" (not "completed" — the cutoff is positional, not proof the days were driven). **Related fix (same change):** the geolocation prompt was consolidated to one on-load request. (Superseded 2026-07-12: the whole client GPS flow now lives in `DeviceLocationContext` — see the "Client GPS pipeline unified" note below — which keeps the single-prompt policy and adds permission-change reactivity.)

**Device location → Penny (migration 0020, 2026-07-01):** the browser Geolocation position captured on app open is now fed to Penny so "my current location" / "where I am" / "plan from here" work without the user typing coords. Flow: `TripWorkspace` gets `getCurrentPosition`, best-effort reverse-geocodes it client-side (`lib/reverseGeocode.ts`, Maps JS Geocoder — the already-enabled key), and POSTs `{lat,lng,place_name}` to `/api/trips/[id]/position`. `updateTripPosition` stores them in `trips.last_known_lat/lng` (existing) + the new **`last_known_place`** text column (migration 0020; only overwritten when a label resolves, so a geocode miss never wipes a good name). `buildPennyContext` projects these as `context.device_location = {lat,lng,place,as_of}` (null when GPS never granted). The Penny prompt (`claude.ts` `<reporting_progress>` + the context-field doc) tells her to use `device_location` directly as the coords for `report_position` and NOT ask the user to type a location when it's present. This is DISTINCT from `trip.current_place` (the progress anchor Penny sets via `report_position`) — the bug was that Penny only ever saw her own anchor, never the device GPS, so she "never knew where the user was" despite the browser having permission. **Apply migration 0020 with `db:migrate` BEFORE deploying** (code selects the new column). Table count unchanged (24) — column add only.

**Past-day fuel suppression (2026-07-01):** legs in the collapsed "Behind you" section no longer lazily source fuel on open or show the "Planning fuel stops…" spinner. `Itinerary` passes `isPast` (cutoff membership — NOT `date_iso < today`, so the *current* leg still plans fuel even if a stale progress anchor left its date in the past) → `LegCard` (skips the lazy fuel effect) → `StopsSection` (suppresses the planning spinner). Opening an old day is instant and quiet.

**Declared tank state (migration 0021, 2026-07-12):** three nullable `trips` columns — `declared_range_km`, `declared_range_leg_id` (plain uuid, no FK — same stale-pointer contract as `current_leg_id`), `declared_range_at` — written by the **declareFuelState** Penny tool (see Penny Tools). Finn reads them via `resolveDeclaredTankAnchor` (`server/fuel.ts`): burned-at-anchor = comfortable − declared (clamped ≥ 0), fed into the `kmBurnedSinceLastRefuel` walk as `declaredBurnedKmAtStart`; a real fuel stop at/after the anchor supersedes it. **Apply migration 0021 with `db:migrate` BEFORE deploying** (code selects the new columns). Table count unchanged (24) — column add only.

**Client GPS pipeline unified (2026-07-12):** `components/DeviceLocationContext.tsx` is now the ONE client geolocation owner: the on-load prompt, a live `watchPosition`, and a Permissions-API `onchange` subscription. `TripWorkspace`'s position report and `useNextStop` (smart nav) consume the shared context; neither calls the Geolocation API directly. **Bug it fixes:** `useNextStop` checked the permission once at card-expand — if the state was `'prompt'` (popup on screen, unanswered) it locked to `'unavailable'` for the whole mount, so granting did nothing and desktop showed the location popup AND the full 3-button nav list simultaneously (trip d0b5741b). Smart-nav selection is extracted to pure `pickNextStop`/`segmentDestinations` (`lib/useNextStop.ts`, unit-tested). Related same-incident fixes: `public/sw.js` no longer caches Next.js **RSC payloads** (`_rsc`/`RSC: 1`/`text/x-component` are excluded like `/api/` — the stale-trips-list-in-PWA bug; CACHE_NAME v6), and `add_stop` rejects stops within **1 km of the leg's end coords** (the duplicate-destination-button incident; see `<app_ui_awareness>` in `claude.ts` — Penny now knows what the nav UI shows and must never answer a display complaint with a data write).

`trips.onboarding_scan` (jsonb, migration 0012) is a transient stash mirroring `pending_intent`: the first-message intent scan (`onboardingIntentScan.ts`) writes validated, prefill-confirm onboarding values here (currently the fuel-range safety numbers) until the question that owns each comes up on the vehicle step; cleared at handoff. The start date isn't stashed — an exact one is applied immediately and its question skipped. See `OnboardingScan` in `types/trip.ts`.

**Vehicle range → Finn handoff (migration 0011):** `vehicles.refill_distance_km` was renamed to **`comfortable_range_km`** (the everyday target Finn aims for) and a new **`hard_max_range_km`** column added (the absolute ceiling Finn must never route a dry stretch past). Captured in onboarding (comfortable required; hard-max optional, **defaults to comfortable** — the one safe fallback). Invariant `comfortable_range_km ≤ hard_max_range_km` is enforced at every write path centrally in `repos/vehicles.ts` (`assertRangeOrder`). Both are projected to Penny/Finn via `projectVehicle` (`hard_max_range_km ?? comfortable_range_km`). Bounds remain `FUEL_STOP_SPACING_KM_MIN/MAX` (200–1500). Penny prose must still not author the safety number. **Range writes locked to onboarding + Settings ONLY (2026-07-02):** `comfortable_range_km`/`hard_max_range_km` were **removed from the `update_vehicle` Penny tool** (schema now `fuel_type` only; the replan dispatcher builds the patch explicitly so nothing else can pass). **Why:** "I'll need to get fuel within 250km of tomorrow's drive" is a fuel REQUEST (→ Finn via `plan_fuel_stops`), but the old prompt ("call update_vehicle whenever they state a range… or you infer one") made Penny silently rewrite the saved comfortable range from it. Now a chat range statement gets "change it in Settings → Vehicle profile"; `<vehicle_preference_updates>` in `claude.ts` spells out the fuel-request-vs-preference distinction. Guard test: `updateVehicle.test.ts` (fails if the range fields reappear in the tool schema). **"I don't know my range" path:** a non-numeric answer on the comfortable step routes to the `range_help` onboarding state → `src/server/parseComfortableRange.ts` (forced-tool estimator, `RANGE_ESTIMATE_MODEL`) proposes a conservative number from the driver's vehicle/tank info → prefilled back on the comfortable step for confirm/edit (never persisted unguarded; falls back to "type a number" if it can't estimate). Pure guard `validateComfortableKm` lives in `vehicleProfile.ts`. **Decided out:** `fuel_type` (not worth onboarding friction). **Follow-up:** collapse the redundant `effective_range_km`/`computeEffectiveRangeKm` alias into `comfortable_range_km`. See `docs/design/penny-comfortable-range.md`.

**Lazy fuel sourcing — BUILT (migration 0013, 2026-06-26):** fuel stops are now sourced **lazily on day-open**, not eagerly across the whole trip during planning (the old eager fan-out was the Google Places cost sink). New column `legs.fuel_stops_updated_at` is the cache timestamp; `FUEL_CACHE_TTL_MS` (48h, `src/lib/fuelCache.ts`) is the staleness window shared by server + client. Flow: the initial plan creates legs/routes only (no fuel calls — Penny's prompt no longer auto-calls `plan_fuel_stops`; she keeps it for **explicit** "find fuel for day N" asks). When the user expands a day, `LegCard`'s effect POSTs `/api/legs/[id]/fuel-stops`, which routes through `planFuelStopsForLegLazy` (`server/fuel.ts`): a terminal-success leg (`ready`/`no_stations_found`) sourced within the TTL is a **cache hit with zero Places calls**; never-sourced or stale legs run the real `planFuelStopsForLeg` search (algorithm untouched) and (re)stamp the cache. `setFuelStatus` stamps the timestamp on terminal-success and clears it on `none`. **Invalidation is affected-leg-only, never a trip-wide re-fan-out:** `invalidateLegFuelCache` (a leg's coords change via `update_leg`, `report_position` re-routing the upcoming leg, or continuity-repair) and `invalidateTripFuelCache` (vehicle/range change on `PATCH /api/trips/[id]`) reset `fuel_status='none'` + drop auto option stops so the affected day re-sources on next open. The "stale → **cheap** price re-check" the design calls for is Finn's separate pricing task (not built — no US price feed); until then a stale cache falls through to a full re-search, kept infrequent by the TTL gate. The trip-wide fan-out (`replenishFuelStopsForTrip` + `POST /api/trips/[id]/fuel-stops/replan` + `api.replenishFuelStops`) was **fully removed 2026-07-02** — lazy per-leg day-open sourcing is the ONLY fuel path; don't reintroduce a whole-trip fan-out. See `docs/mvp-cleanup/06-lazy-fuel-sourcing.md`. **`failed` legs DO re-source on day-open (2026-06-30):** `LegCard`'s `needsFetch` now includes `fuel_status==='failed'` (not just `none`/stale-success). The old rule skipped `failed` to avoid re-hitting *paid* Google Places on every expand; with Finn on free OSM/OSRM that cost is gone, and auto-retry self-heals legs stranded on a stale pre-cutover error (`'computing'`/`'pending'` are still skipped — search in flight; the signature guard stops duplicate fires per render).

**Finn cutover — station source is now OSM, not Google Places (2026-06-26):** `planFuelStopsForLeg` (`server/fuel.ts`) was rebuilt to run on **Finn**: OSRM route geometry → **OSM Overpass corridor** (`lib/osm/overpass.ts`) → **eligibility filter** (`lib/finn/stationFilter.ts`, drops truck-only / private stations — the "St1 Truck" bug) → **route projection** (`lib/finn/route.ts`) → **greedy multi-stop placement** (`lib/finn/plan.ts`, never past `hard_max_range_km`, prefers comfortable range, prefers priced+cheapest once pricing exists). The lazy day-open flow, TTL cache, and invalidation seams are unchanged — only the guts behind `planFuelStopsForLeg` swapped. **Deleted:** `src/server/fuelPlaces.ts` (Google Places adapter) + `src/server/fuel.test.ts` (its tests). There is now exactly **one** fuel planner. Fuel `stops.source` is now `'osm'` (was `'google_places'`); OSM stations have no Google `place_id`, so the "open in Maps" link is built from lat/lng (`StopCard` already falls back to coords). New tests: `lib/finn/plan.test.ts`, `lib/finn/stationFilter.test.ts`. See `docs/design/finn-fuel-agent.md`. **Two follow-up fixes (2026-06-30):** (1) **Trivial-leg short-circuit** — a leg whose start ≈ end (within `TRIVIAL_LEG_KM = 0.1`) now returns a clean `ready`/0-stops BEFORE the OSRM call. Previously a zero-distance route decoded to <2 points and hard-failed as "Route geometry was unusable" — this was ~every `failed` leg in prod (same-place legs). (2) **Finn failures are logged to `usage_events`** (provider `finn:fuel-plan`, `success=false`) via the new `failLeg` helper, so fuel-planning failures reappear in `/admin/errors`. Before the OSM cutover, Places failures logged via `recordGooglePlacesUsage`; Finn's failures wrote only to `legs.fuel_plan_error` and were invisible to the admin error log (which reads only `usage_events WHERE success=false`).

**Fuel pricing — BUILT (migration 0016, 2026-06-26):** `src/lib/fuelPricing/` is the region-pluggable price layer. Tri-state `PriceResult` (`priced | unknown | unavailable_in_country`, never silent null), a static country coverage map (`coverage.ts`: feed countries = DE; no-price countries = the Nordics), and a `coordinator.ts` that runs providers (bulk feeds before per-station). Providers: `tankerkoenig.ts` (DE open feed, `bulk`, selection-grade, matched to OSM candidates by coords) and `google.ts` (`fuelOptions`, `per_station`, global fallback, live/non-stored). `server/fuelPricingProviders.ts` builds them from env (`TANKERKOENIG_API_KEY` + Google key); **no keys → graceful degradation** (everything `unknown`/`unavailable`, selection falls back to distance). Wired into `planFuelStopsForLeg`: bulk pricing over all candidates feeds the planner's cheapest-priced preference; chosen finalists get an authoritative tri-state (per-station Google fills gaps, Nordics resolve to `unavailable_in_country` without a call). Persisted on `stops` (`price_state`/`price_per_litre`/`price_currency`/`price_fuel_type`/`price_country`/`price_source`/`price_as_of`, migration 0016) and shown in `StopCard`. Fuel type comes from new `vehicles.fuel_type` (migration 0016; default diesel when null) — settable via `update_vehicle` + `PATCH /api/vehicles/[id]`. **Still TODO:** a fuel-type onboarding question + Settings select (default diesel covers it for now), FR/ES/IT feed adapters, a cheap price-refresh path, and `legs.fuel_plan_hash`/`trips.start_fuel_fraction`. The Penny prompt's "NO PRICES" rule in `claude.ts` should be revisited once pricing is live in prod (Penny still must not author price numbers — the UI shows them). Tests: `lib/fuelPricing/*`. See `docs/design/finn-fuel-agent.md`.

**Dormant DB remnants (MVP teardown, 2026-06-26):** the `trips.trip_status` column/enum (`draft/active/paused/completed`) still exists but is **unwired** (lifecycle transitions removed). Leave dormant or drop in a later migration; don't re-wire without revisiting MVP scope. Note: `trip.status` (`planning/research/confirmed/anchored`) is a *different*, still-live field — the workflow badge shown in the UI.

**Dump station — fully removed (migration 0015, 2026-06-26):** the vehicle `dump_station_interval_days` / `dump_station_tracking_enabled` columns were **dropped** and the `dump_station` **stop type** + its finder were deleted: `server/dump-stations.ts`, `server/places/nearby-dump-stations.ts`, `POST /api/stops/[id]/find-alternative`, the "Find other station" button in `StopsSection`, the `dump_station` `StopCard`/`LegCard` rendering, and `dump_station` from every `stop_type` enum (`shared.ts`, `addStop`, `updateStop`, `api/stops`, `api/stops/[id]`, `StopType`). `stops.stop_type` is a plain text column so no enum migration was needed.

**Onboarding teardown (MVP, 2026-06-26):** onboarding now collects only the vehicle **name + comfortable range (+ optional hard-max ceiling)**.

**Travel style — fully deleted (migration 0014, 2026-06-26):** there is no travel-style concept anywhere anymore — Penny has no notion of it. The columns `vehicles.travel_style` (+ the `travel_style` pg enum), `cruise_max_drive_hours`, `transit_max_drive_hours`, `max_drive_hours_per_day`, `max_drive_hours_per_week` were **dropped** (migration `0014_drop_travel_style_and_remediation.sql`), along with all code: `TravelStyle`/`TRAVEL_STYLE_OPTIONS`/`deriveFromTravelStyle`/`deriveMaxDriveHoursPerWeek` helpers, the per-leg cap projection, and the Settings/admin display. Every driving day is now capped at a flat **`DEFAULT_MAX_DRIVE_HOURS_PER_DAY = 8`** (`vehicleProfile.ts`) — the leg validators (`addLeg`/`updateLeg`) and `get_route` splitting use the constant directly, no per-vehicle cap. The `update_vehicle` Penny tool now carries `fuel_type` ONLY (ranges removed 2026-07-02 — see the range-lockdown note above; defaults to diesel). The driving-cadence columns `max_consecutive_drive_days` / `rest_days_after_driving` were also **dropped** (migration `0015_drop_vehicle_cadence_dump_columns.sql`, alongside the dump-station columns). The MVP `vehicles` row is name + comfortable/hard-max range + `fuel_type` (added 2026-06-26 for fuel pricing; defaults to diesel).

**Stop-type teardown — DONE (2026-06-26):** `StopType` reduced to **`'fuel' | 'other'`** (`other` = the user-added stop: link/address/place name). Removed the `food` (groceries) and `overnight` stop types and the `rest` (parks) **stop type**, plus all their wiring: the parks/groceries finders (`server/places/nearby-parks.ts` + `api/places/nearby-parks`), the dead `nearby-stops` route/stub, the deprecated `MoreStopsModal` (+ test), `api.ts nearbyParks`, the overnight route-option split + `variant='overnight'` StopCard styling in `StopsSection`/`StopCard`, and `useStopActions` `addNearbyPlace`/`setOvernight` (the paste-GPS flow now tags stops `other`, not `overnight`). `fuel.ts` lost its legacy auto-stretch-break `rest` references (`AUTO_STRETCH_BREAK_NOTE_PREFIX`; the break-finding feature was already gone). The Penny prompt (`claude.ts`) no longer tells her to emit `overnight` stops or offer amenity finding. Enums trimmed in `shared.ts`, `addStop`, `updateStop`, `api/stops`, `api/stops/[id]`, `types/trip.ts`. `stops.stop_type` is plain text → no migration; legacy `food`/`overnight`/`rest` rows (none in prod — no users yet) would just be orphan strings, optionally swept to `other`. **NOT touched:** the `leg_type: 'rest'` rest-**day** path, and `add_route` alternative-destination (route-option) picking — both stay. **Deferred (post-MVP):** the `dog_park`/`park` **route-link** types in `routeLinkTypeSchema`/`addRoute`/`updateRoute` are still present (separate from stops); trim later if desired.

**Stop photos — fully removed (2026-06-30):** the Place Photos / Street View "stop photos" feature is gone (it was a post-MVP nicety and the Google Places Photo Details + Street View Static calls were a cost the MVP doesn't need). Deleted (run `rm`): `server/places/photos.ts` (the Google fetcher) + `api/places/photos/route.ts` (the endpoint — it was already orphaned, nothing called it). Stripped from app code: the `StopPhoto` type + `photos`/`photosLoading` on `StopCard`, the `photosMap` in `StopsSection`, `photos` on the `Stop` type (`types/trip.ts`), `CreateStopInput`/`UpdateStopInput` + the insert/update in `repos/stops.ts`, and the `repos/trips.ts` row mapping. Tests updated (`StopCard`, `StopsSection`, `tripDataContract`) and the `noExternalCallsGuard` `/api/places/photos` pattern removed. **DB:** `stops.photos` (jsonb) is left **dormant** (column + `StopPhoto` type stay in `schema.ts`, always null now) — drop in a later migration if desired, like `trips.trip_status`. The only remaining Google Places call is the `fuelOptions` per-station price fallback (`fuelPricing/providers/google.ts`); with Finn on free OSM/OSRM, Google spend should now be just Directions + the JS Maps SDK + geocoding + that price fallback.

**Penny never redefines a REST leg — ENFORCED (2026-07-03):** `update_leg` rejects location/route-metric edits (`title`, `start/end_name`, `start/end_lat/lng`, `distance_km`, `drive_time_minutes`) on `leg_type='rest'` legs at BOTH layers: the tool validator (in-loop — context legs carry `leg_type`, so Penny sees the instructive rejection and self-corrects within the turn) and the dispatcher (apply-time, covers stale-context/remapped ids). Non-route fields (notes/status/color/costs) stay editable. **Why:** `rebuildTripSchedule` re-materializes every rest day as "stay at the previous drive's end", so such an edit was silently reverted seconds after landing while Penny's prose claimed it saved — the "campsite near Alset" incident (prod 2026-07-02, trip 42fc7780): "go camp here tomorrow" + Maps link → Penny turned the Trondheim rest day into a pseudo-drive to the campsite, the rebuild put it back, the user was told the campsite was saved, and the plan contained it nowhere (phantom 53.1km/88min metrics were left on the rest-day row). Helpers `restLegBlockedFields`/`restLegEditRejectionMessage` in `updateLeg.ts`; test `updateLeg.test.ts`. Related same-family seams: the `<pasted_place_disambiguation>` prompt section in `claude.ts` (ambiguous "go here" + link/name → Penny asks ONE question — stop along the way vs end-of-day — before ANY plan edit; explicit phrasing skips the question), the anchor-aware post-dispatch `checkLegContiguity` (2026-07-03 — it now starts at the progress-anchor pair, mirroring `repairLegContinuity`; it previously re-logged the same behind-you gap, e.g. the 217km Bøverkinnhalsen→Heimdal jump, to /admin/errors on EVERY turn), and `lib/penny/editOverride.ts` (see Architecture tree).

**Penny never authors fuel stops — ENFORCED (2026-06-26):** the global `stopTypeSchema` stays `'fuel' | 'other'` (the server-side fuel planner + repo + API still write `fuel` rows), but **Penny's `add_stop` tool is now locked to `stop_type: 'other'` only** (`addStopTypeSchema = z.literal('other')` in `addStop.ts`; fuel_type/fuel_amount fields removed from that tool, and the `route.ts` dispatcher hard-codes them to null). `update_stop`'s *settable* `stop_type` is likewise `'other'`-only, so Penny can update an existing fuel stop's status/coords but can't convert anything **into** fuel. **Why:** `add_stop` previously let Penny mint a coordinate-less placeholder fuel row (e.g. "Fuel stop — Aurdal (departure)", 0 km, source `penny`) that pointed at no real station — an empty stop that does nothing. Architecture is now: Penny is the comms layer; **every fuel request routes to Finn via `plan_fuel_stops`** (real OSRM route + OSM Overpass station search), the only `add_stop` Penny does is a user-named `other` place. `<fuel_planning_rules>` in `claude.ts` rewritten to match (and the stale "dump stations/overnight/food" capability line fixed). Known gap (Finn's task, not built): Finn's greedy planner won't place a stop "exactly at the start"/at a named km — Penny reports "none needed" honestly instead of faking a marker. Test: `addStop.test.ts`.

**Vehicle remediation — fully removed (migration 0014, 2026-06-26):** the multi-step remediation overlay/wizard was deleted. Onboarding always collects the comfortable range, so the only completeness signal needed is a live check in `buildPennyContext` (`vehicle_profile_blocked = !vehicleMeetsFuelPlanningMinimum(...)`) that lets Penny nudge "set your range" in chat. Gone: the `users.needs_vehicle_profile_remediation` column, `server/vehicleRemediation.ts`, `repos/remediationFlags.ts`, `vehicleRemediationGateLog.ts`, `GET/POST /api/me/vehicle-remediation`, the `VehicleRemediationOverlay` UI in `ChatPanel`, the `remediation-diagnose`/`remediation-backfill` scripts, and the `vehicle-remediation` e2e spec. `vehicleIsCompleteForRemediation`/`storedVehicleProfileFieldNeedsRemediationRepair`/`vehicleMeetsCompletenessTier` were deleted from `vehicleProfile.ts`. See `docs/mvp-cleanup/01-onboarding-teardown.md`.

### Repos (`src/server/repos/`)

trips, routes, stops, vehicles, users, tasks, pois, chat, gpx, usage, admin, announcements, pennyTurns, testSupport (test-only)

### Penny Tools (`src/lib/penny/tools/`)

addStop, updateStop, deleteStop, addLeg, updateLeg, deleteLeg, addRoute, updateRoute, deleteRoute, getRoute, resolvePlace, addTask, updateTask, updateVehicle, renameTrip, reportPosition, submitIdea, checkTripFeasibility, planFuelStops, declareFuelState, extractTripIntent — registered in `index.ts`, shared helpers in `shared.ts`

- **resolvePlace** is the deterministic name→coordinates lookup (`src/lib/google/geocode.ts`, Google Places Text Search → Geocoding fallback). It is the ONLY sanctioned source of lat/lng for a named location — the Penny prompt forbids her from authoring coordinates from her own knowledge (the "dropped me near the right city, wrong spot" bug). Returns a tri-state with granularity (precise/locality/area/country); a coarse centroid for a query that named a specific place is treated as too-vague and Penny clarifies instead of pinning. A LOOKUP tool (runs inline, doesn't write to the DB).

- **reportPosition** records the driver's real-world progress: sets the trip's `current_leg_id` + position anchor, re-points the upcoming leg to start where they are, and re-anchors the calendar from now. This is the lever behind "I'm in X, didn't reach Y".
- **submitIdea** logs an unsupported-but-reasonable feature request to `usage_events` (provider `penny:user-idea`) so the team can read it — keeps Penny from faking capabilities the app lacks (e.g. fuel prices).
- **declareFuelState** (2026-07-12) records the driver's stated CURRENT tank ("I only have 150 km in the tank") — the third fuel category alongside range preferences (Settings-only) and fuel requests (Finn). Writes `trips.declared_range_km/_leg_id/_at` (migration 0021); Finn's tank walk treats it as the remaining-range baseline at the anchor leg's start (`resolveDeclaredTankAnchor` in `server/fuel.ts` + `declaredBurnedKmAtStart` in `fuelTankState.ts`), superseded automatically by any real fuel stop after the anchor. Runs INLINE (a lookup with a DB write, like plan_fuel_stops) so a same-turn plan_fuel_stops re-run sees it; it also invalidates the fuel cache for the anchor leg onward. Prompt: `<vehicle_preference_updates>` teaches the three-way distinction + "ask one clarifying question instead of pushing back" when a number is ambiguous. Origin: trip d0b5741b — driver said he'd run dry at 150 km, Finn's stop sat at 181 km off the saved 500 km range, and Penny could only argue or point at Settings. Known gap: declarations don't expire on report_position — a stale one biases Finn conservative (extra dismissable stop) until a fuel stop passes or a new declaration lands.

### Scripts (`scripts/`)

ship.sh, run-migrations.ts, seed-demo-trip.ts, smoke-api.ts, db-reset.ts, seed-migration-journal.ts, backfill-google-maps-nav.ts, backfill-anthropic-zero-cost-rows.ts, reconcile-anthropic-spend.ts, migrate-sqlite-to-neon.ts, verify-maps-waypoints.ts, seed-first-announcement.ts

(E2E fixtures are seeded/cleaned over HTTP via `/api/test/*` from `global-setup.ts`/`global-teardown.ts` — the old `seed-e2e-fixture.ts` / `cleanup-e2e.ts` SQL scripts + `e2e:seed`/`e2e:cleanup` npm scripts were removed.)

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
- **Mobile auth (2026-07-31, `feature/ios-app`):** the Expo app (`mobile/`) signs in via `POST /api/mobile/otp/send` + `/verify` — the SAME OTP machinery as web (`signInWithOtpCore` in `auth/otp.ts`, extracted from `signInWithOtp`), but the session token is returned in the body instead of a Set-Cookie. The app stores it in the iOS keychain and sends `Authorization: Bearer <token>`; `requireUserId`/`requireUser` (guards.ts) resolve bearer tokens against the same `sessions` table as the cookie path. NOT a parallel auth system, NOT a bypass — no token exists without a completed OTP sign-in. Admin guards deliberately stay cookie-only.

## Conventions

- No `any` types. Use Zod schemas for API input validation.
- CSS Modules for component-scoped styles (e.g., `admin.module.css`).
- Server components by default; `"use client"` only when needed.
- Env vars: copy `.env.example` to `.env`. Never commit `.env`.
- **Google Maps: there is exactly ONE API key — `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.** It is used for BOTH the browser Maps JS and every server-side Google REST call (Directions, Geocoding, Places). `GOOGLE_MAPS_SERVER_API_KEY` and the `src/server/google-maps-server-key.ts` helper are dead scaffolding — that env var is NOT set in Vercel, so the helper always falls back to the one public key. Do NOT assume a separate server key exists; do NOT propose "use the server key" as a fix. (This has confused past assistants repeatedly — hence this note.)
- Admin access: hardcoded allowlist in `src/server/auth/admin.ts`.
- **Never silently swallow errors.** Every mutation must either show inline error UI or go through the global `ErrorNotifier`. No empty `catch` blocks, no `console.error`-only handling. If something fails, the user must know.

## Working with this codebase

- **Schema changes:** Edit `schema.ts` → `npm run db:generate` → `npm run db:migrate`
- **New API route:** Create `src/app/api/<resource>/route.ts`, add repo if needed
- **New Penny tool:** Add to `src/lib/penny/tools/`, register in `index.ts`
- **E2E tests:** Playwright starts the app itself (webServer) and seeds fixtures over HTTP via `/api/test/*` in `global-setup.ts` — no manual seed step. In CI they run against an ephemeral Neon branch.

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
