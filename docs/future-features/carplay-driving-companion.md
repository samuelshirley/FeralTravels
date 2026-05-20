# CarPlay Driving Companion

## Status: Future Feature (Long-term)

## Vision

A native iOS app that acts as a driving companion for trip-planner, with
an eventual CarPlay integration. The driver sees today's route on a map,
their upcoming stops in a glanceable list, and can talk to Penny via voice
to make on-the-fly changes — add a gas stop, find water, detour to
groceries — without touching the screen.

## Important constraints

CarPlay does **not** support webviews, iframes, or arbitrary layouts.
Apple locks the UI to predefined templates (CPMapTemplate, CPListTemplate,
etc.) for driver safety. You cannot embed Google Maps in an iframe — you
either render a native map yourself or hand off navigation to a separate
maps app. Any CarPlay app must pass Apple's review, and Navigation-category
apps require a separate entitlement that Apple gates.

## Phased approach

### Phase 0: Mobile-optimized web app (prerequisite)

Before any native iOS work, the existing Next.js app needs a proper
mobile/PWA experience. This is being scoped separately and is the true
step one — it validates the driving-mode UX in a browser before investing
in native development.

- Responsive driving-mode view: today's stops as big glanceable cards
- "Navigate" button per leg that deep-links to Google Maps / Apple Maps
- Voice-to-Penny via Web Speech API or whisper transcription
- This alone gets ~80% of the value with ~20% of the effort

### Phase 1: Native iOS companion app (no CarPlay)

A lightweight Swift/SwiftUI app that consumes the trip-planner API. This
is the real proving ground — if people don't use this, CarPlay isn't
worth building.

**What it does:**

- Displays today's active trip leg with a native MapKit view showing
  the route and stop pins
- List view of today's stops: name, type, ETA, distance
- Push-to-talk button for Penny voice interaction
- "Navigate in Maps" button that deep-links each leg to Google Maps or
  Apple Maps (user's choice)
- Real-time sync: changes made in the iOS app reflect in the web app
  and vice versa (co-pilot on phone scenario)

**What it needs:**

- iOS app (Swift, SwiftUI)
- API auth: expose a token-based auth flow for native clients (the
  existing NextAuth session cookies won't work from a native app)
- New API endpoints:
  - `GET /api/trips/:id/today` — returns today's active leg with stops
  - `POST /api/trips/:id/stops/insert` — insert an ad-hoc stop at a
    position along the current route
  - `GET /api/trips/:id/nearby?type=fuel|water|groceries` — POI search
    along the active route corridor
- Voice pipeline: record audio -> Whisper transcription -> Penny tool
  call -> TTS response (or use iOS Speech framework for on-device
  transcription)
- Push notifications via APNs for proactive Penny alerts

### Phase 2: CarPlay integration

Add CarPlay support to the Phase 1 iOS app. This is a significant step
up in complexity.

**Option A: CarPlay Navigation app (hard mode)**

- Register as a Navigation app (requires Apple CarPlay Navigation
  entitlement — apply via MFi portal, approval takes weeks)
- Use `CPMapTemplate` to render the route on a native map
- Provide turn-by-turn guidance using either:
  - MapKit directions (free, less capable)
  - Google Maps Navigation SDK for iOS (paid license, better quality)
- `CPNavigationSession` manages the active route, maneuvers, ETAs
- Trip estimate panel shows next stop info
- Navigation alerts for Penny's proactive suggestions
- This makes trip-planner a full replacement for Google Maps while
  driving — high effort, high payoff

**Option B: CarPlay companion app (pragmatic mode)**

- Register as a Communication or Audio-style app (no nav entitlement
  needed)
- `CPListTemplate` shows today's stops in a scrollable list
- `CPVoiceControlTemplate` or custom voice button for Penny
- Navigation still hands off to Google Maps / Apple Maps
- Much lower barrier to entry, but no map on the CarPlay screen
- This is probably the right v1 if Phase 1 proves the concept

**Regardless of option, the CarPlay UI supports:**

- Viewing today's stops (name, type, ETA)
- Penny voice interaction: "add a gas stop before Flagstaff", "find
  water near me", "push lunch to 2pm"
- Route update confirmations shown as CarPlay alerts
- Siri Shortcuts integration for common actions

## Voice interaction examples

These show how Penny works while driving — hands-free, conversational:

```
Driver: "Hey Penny, I need gas sooner than planned"
Penny:  "There's a Shell station in 12 miles, or a cheaper Costco
         22 miles ahead but 3 miles off-route. Which one?"
Driver: "The Costco"
Penny:  "Added Costco fuel stop. Your ETA at camp pushes back 15
         minutes to 4:45 PM."
```

```
Driver: "Find me a place to fill water bottles"
Penny:  "There's a rest area with potable water in 8 miles, or a
         Walmart in 14 miles where you could also grab groceries."
Driver: "The rest area"
Penny:  "Got it — water stop added. 5 minutes off your route."
```

```
Driver: "Add a grocery stop somewhere before we get to camp"
Penny:  "I see a Kroger in Flagstaff, 45 minutes ahead. That's
         right on your route. Want me to add it?"
Driver: "Yeah, do it"
Penny:  "Kroger stop added in Flagstaff. I bumped your campsite
         arrival to 5:15 PM — still well before sunset."
```

## New API endpoints needed

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/trips/:id/today` | GET | Today's active leg, stops, and route |
| `/api/trips/:id/position` | POST | Report driver's GPS position |
| `/api/trips/:id/stops/insert` | POST | Insert ad-hoc stop into route |
| `/api/trips/:id/nearby` | GET | POI search along route corridor |
| `/api/auth/token` | POST | Issue API token for native app auth |

Most of these overlap with the Penny location awareness feature — that
should be built first or in parallel.

## Technical decisions to make

- **Navigation SDK:** MapKit (free, Apple-only) vs Google Maps
  Navigation SDK (paid, better routing, matches the web app's data).
  The Google SDK requires a commercial license — need to price this out.
- **Voice pipeline:** On-device (iOS Speech framework, lower latency,
  works offline) vs server-side (Whisper, more accurate, needs
  connectivity). Could do on-device for transcription, server for Penny
  processing.
- **Auth for native clients:** JWT tokens? OAuth2 device flow? Needs to
  work seamlessly with existing NextAuth setup.
- **Real-time sync:** WebSocket from the iOS app, or polling? WebSocket
  is better UX but adds server infra.

## Dependencies

- Phase 0 (mobile-optimized web app) — validates the UX first
- Penny location awareness feature — shares position tracking and
  proactive alert infrastructure
- Apple Developer account ($99/year)
- Apple CarPlay entitlement (Phase 2 only, if going Navigation route)
- Google Maps Navigation SDK license (Phase 2A only, if not using MapKit)
- Push notification infrastructure (APNs)

## Effort estimates (rough)

- **Phase 0** (mobile web): 2-4 weeks — mostly responsive CSS/layout
  work and voice API integration
- **Phase 1** (native iOS, no CarPlay): 2-3 months — new app from
  scratch, API work, voice pipeline, push notifications
- **Phase 2B** (CarPlay companion): 1-2 months on top of Phase 1 —
  list-based UI, voice template, no map
- **Phase 2A** (CarPlay navigation): 3-6 months on top of Phase 1 —
  full nav engine, map rendering, turn-by-turn, Apple entitlement process

## Privacy considerations

- GPS position tracking requires explicit opt-in (same as location
  awareness feature)
- Voice recordings: process and discard, never persist raw audio
- CarPlay usage data: minimal telemetry, no recording of conversations
- All position/voice data encrypted in transit
