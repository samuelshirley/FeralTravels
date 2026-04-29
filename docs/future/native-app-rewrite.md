# Native app rewrite (Expo + React Native)

## Why deferred

The current PWA works. It's installable on iOS via Add to Home Screen, has a
service worker, manifest, and a mobile-friendly responsive layout. We have
**zero users**, so there's no urgency to be in the App Store this month. A
React Native rewrite is genuinely weeks of focused work and would freeze
feature velocity on the web app while it's in flight.

Defer until at least one of these is true:

1. We have real users asking for a native app.
2. We hit a PWA limitation that materially hurts the product (most likely:
   offline tile caching for remote driving, background GPS for live tracking,
   push notifications for trip-day reminders).
3. App Store presence becomes a marketing requirement (paid ads, partnerships,
   App Store featuring).

## Goals if we do this

- App Store + Play Store presence.
- Better mobile UX — native gestures, animations, scrolling.
- Native-only features:
  - Offline tile caching (real win for overlanding in remote areas with no
    cell signal).
  - Background GPS / live position on the leg.
  - Push notifications for trip-day reminders, "you've drifted off route",
    "pick tonight's stop" task nudges.
  - Native turn-by-turn handoff to Apple/Google Maps.

## Paths considered

### A. Capacitor wrapper (rejected)

Wrap the existing Next.js app in a Capacitor native shell, ship a WebView app
to the App Store. **Cost:** 1-3 days. **Decision:** rejected. The work gets
thrown away when we do the real rewrite. With no users, there's no reason to
ship a stopgap that costs 1-3 days and gets deleted.

### B. PWA improvements only (current state, kept as fallback)

Tighten what we have: better install prompt, web push (iOS 16.4+), offline
service worker for trip data and map tiles. No App Store. Keep one codebase.
This is the path we stay on until we commit to (C).

### C. Expo + React Native rewrite (the chosen future path)

Reframe as a unified Expo project with `react-native-web` for the web target
(or keep Next.js for web and have Expo for native — see "Open question:
monorepo shape" below).

- **Backend** (Next.js API routes) stays as-is. Penny logic, DB queries, auth
  models — all unchanged. The rewrite is UI-only.
- **UI** ports from `<div>` + inline styles to `<View>` + StyleSheet. Most
  components (LegCard, RoutesSection, ChatPanel) are pure presentation and
  port mechanically. The hard ones are TripMap (needs `react-native-maps`)
  and any chat input that uses browser-only APIs.
- **Auth** is the messiest piece. Web uses next-auth with DB sessions in a
  cookie. Native needs JWT-in-secure-storage or a token endpoint that hands
  off after Google OAuth. `expo-auth-session/providers/google` for Google;
  magic links via Resend keep working unchanged (link goes to web URL,
  callback exchanges a token).
- **Map** uses `react-native-maps`. Native Google Maps on Android, Apple
  Maps on iOS by default but can force Google. Tile caching for offline is
  available via `react-native-maps-tiles-cache` or implementing with
  mapbox-gl-native.
- **Penny** stays exactly where it is. Native client just calls
  `/api/replan` like the web client does.

## Realistic scope

Single dev with Claude doing the heavy lifting:

- **Session 1-2:** Expo scaffold, auth flow, trips list, trip detail screen,
  stub map. Runs on iOS simulator end-to-end with Penny working. No App Store
  yet.
- **Session 3-6:** Feature parity with web — chat panel, leg cards, routes,
  stops, fuel planning, vehicle settings, admin dashboard.
- **Session 7-9:** Native features — offline tiles, background GPS, push
  notifications, share sheet, deep linking.
- **Session 10-12:** App Store submission — assets, screenshots, privacy
  manifest, review iterations (Apple WILL reject the first submission for
  something).

So weeks of calendar time, even with focused sessions.

## Open question: monorepo shape

Two options, both monorepo:

1. **`pnpm` workspaces with `web/` + `mobile/` + `shared/`.** Keep web app in
   `web/` (current Next.js). Native lives in `mobile/` (Expo). `shared/`
   holds types, the API client, and pure-function logic that both consume.
   Backend stays in `web/api/*` and mobile calls those over HTTPS. Two
   codebases for UI, one for backend.

2. **Expo with `react-native-web` for web target.** One codebase, runs
   everywhere. Drop Next.js entirely or keep it only as a marketing
   landing page. Cleaner long-term but bigger upfront migration — current
   Next.js features like server components, server actions, App Router
   don't have direct equivalents.

Sam's lean: option 1, monorepo. Reuses current Next.js work as-is. Only the
native UI is new code.

## Resumption checklist

When picking this back up:

1. **Confirm Apple Developer account is active** — $99/year, can take days
   to clear ID verification. Without it, no TestFlight, no App Store.
2. **Decide monorepo shape** — option 1 or 2 from above. Default: option 1.
3. **Move current code into `web/`** subdirectory. Update Vercel deploy
   config to point at `web/`.
4. **`npx create-expo-app mobile/ --template blank-typescript`.**
5. **Set up `shared/`** with types pulled from `web/src/types/` and a thin
   `apiFetch` that both web and mobile use.
6. **Port auth first** — get sign-in working on iOS simulator. This unblocks
   everything else.
7. **Then trips list → trip detail → chat panel → map.** Iterate.
8. **Defer offline tiles, push notifications, background GPS until UI is
   feature-complete.** They're each their own session of work.

## Things I'd push back on if Future-Sam revisits

- "Can we just do it in a weekend?" No. A weekend gets you maybe trips list
  + auth working. Real feature parity is multi-week.
- "Capacitor is the fastest path." Only if you need App Store presence
  TODAY for a deadline. Otherwise it's wasted work.
- "Drop the web app entirely." Don't, until native is shipping and validated.
  Web is the marketing surface and the demo trip viewer; deleting it before
  native is in the App Store is a mistake.
