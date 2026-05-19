# Penny Location Awareness

## Status: Future Feature

## Vision

Penny should be aware of where the user is on their trip so she can give
contextual, proactive suggestions rather than generic advice.

## What exists today

- Client-side `useNextStop` hook uses the browser Geolocation API to
  determine the next navigation stop. This is purely client-side — Penny
  has no access to the user's position.

## What we'd build

### 1. Trip progress tracking (server-side)

- New `trip_progress` table: `{ user_id, trip_id, leg_id, lat, lng, updated_at }`
- Lightweight API endpoint (`POST /api/trips/:id/position`) that the
  client pings periodically (every 5 min? configurable) with GPS coords
- Edge cases: offline buffering (queue positions in localStorage, flush
  when back online), battery impact (use `watchPosition` with reduced
  accuracy when backgrounded)

### 2. Penny context injection

- When building Penny's context (`src/lib/penny/context.ts`), include
  the user's last known position and derived state:
  - Which leg they're on
  - Which stop they just passed / are approaching
  - Estimated arrival time at next stop
  - Distance remaining in the leg
- This lets Penny say things like "You're 30 min from your fuel stop —
  there's a cheaper station 5 km off-route" or "Weather ahead looks rough,
  consider the alternate route through X"

### 3. Proactive notifications

- Once Penny knows position, she can trigger push notifications or
  in-app alerts:
  - Fuel stop approaching
  - Weather change on route ahead
  - Campsite check-in time window
  - "You've been driving 4 hours — time for a break?"

### 4. Trip timeline / "where was I"

- Persist position history to build a trip journal
- Show on the map where the user actually drove vs planned route
- Post-trip: "You spent 2 hours at Nancy — want to add a note?"

## Privacy considerations

- Position data is sensitive — needs explicit opt-in toggle
- Clear data retention policy (auto-delete after trip ends? keep for
  journal?)
- Never share position with other users without consent
- All position data encrypted at rest

## Dependencies

- Push notification infrastructure (web push or mobile app)
- Reliable background geolocation (harder on iOS Safari)
- Offline-first position queue
