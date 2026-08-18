# iOS parity port — state at hand-off

**Verification performed: `npx tsc --noEmit` → 0 errors, whole project.**
**Nothing here has run on a simulator or device.** Typecheck is the only
automated check. Treat every screen as unreviewed until you have run it.

## Every screen is now written

| Area | Files | Lines |
|---|---|---|
| App shell / routing | `app/_layout.tsx`, `app/index.tsx` | 83 |
| Sign-in | `app/sign-in.tsx`, `lib/oauth.ts` | 785 |
| Trips list | `app/trips/index.tsx`, `components/TripCard.tsx` | 814 |
| Workspace shell | `app/trips/[tripId].tsx`, `BottomNav`, `TripHeader` | 1089 |
| Itinerary | `Itinerary.tsx`, `LegCard.tsx` | 1307 |
| Stops | `StopsSection.tsx`, `StopCard.tsx`, `useStopActions.ts` | 706 |
| Map | `TripMap.tsx` | ~600 |
| Penny chat | `ChatPanel.tsx` + `components/chat/*` | ~1900 |
| Settings | `app/settings.tsx`, `VehicleProfileSection.tsx`, `UnitsToggle.tsx` | 984 |
| Modals | `AnnouncementModal.tsx`, `SupportModal.tsx` | 369 |
| Infrastructure | `lib/api.ts`, `units`, `location`, `errors`, `theme`, `auth`, `config` | ~830 |
| **Shared (mirrored verbatim from `src/lib`)** | 16 modules | 2953 |

~10,600 lines of app code + ~2,950 shared.

## The structural change that matters

Every module in `src/lib` turned out to be DOM-free. They are now **mirrored
byte-for-byte** into `mobile/shared/` rather than reimplemented: `dates`,
`dayModel`, `maps`, `coords`, `polyline`, `mapClustering`, `vehicleProfile`,
`useNextStop`, `fuelPlanErrorSemantics`, `legSegmentGrouping`, `units`,
`sillyErrors`, `validation`, `models`, `vehicleNumericCoercion`, `types/trip`.

Distance formatting, leg-date maths, nav URL building, fuel-error
classification and the vehicle form's field config are therefore *the same
code* on both platforms, not two implementations that drift. Regenerate with
`npm run sync:shared`; never hand-edit `mobile/shared/`.

## Server-side work produced (NOT applied to `src/`)

- `server/oauth-exchange-route.ts` → belongs at `src/app/api/mobile/oauth/exchange/route.ts`.
  Verifies the Google/Apple ID token against the provider JWKS with `jose`,
  checks `iss`/`aud`/`exp`, requires `email_verified` for Google.
  **Has a `TODO(sam)`**: it needs `createSessionForEmail` extracted out of the
  existing `signInWithOtpCore` so both sign-in paths mint sessions identically.
  It will not compile until you do that.
- `server/README-oauth.md` — the credentials you must create.

## What YOU have to do before it runs

1. `cd mobile && npx expo install --fix`
2. **`react-native-maps` does not work in Expo Go** — you need a development
   build: `npx expo run:ios` (or an EAS dev build).
3. Set `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` (a NEW Google Cloud **iOS** OAuth
   client — not the existing web `AUTH_GOOGLE_ID`) or the Google button hides
   itself. See `server/README-oauth.md`.
4. Set `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` or the map falls back to Apple Maps.
5. `npm i jose` in the Next app for the OAuth route.

## Known gaps and judgement calls (from the agents that wrote each part)

- `components/chat/types.ts` — `deriveApplyOutcome`'s three user-facing strings
  were **reconstructed**; `src/lib/penny/applyOutcome.ts` was not in the
  snapshot. Diff before shipping. Loud comment in place.
- `/api/support` is **cookie-only auth** server-side, so the support modal will
  401 from the app. UI is faithful; route needs `requireUserId()` (which accepts
  bearer) instead of `auth()`.
- Position reporting sends `place_name: null` — native reverse geocoding via
  `expo-location` is a follow-up (`TODO(sam)` in place).
- Admin surfaces deliberately not ported: admin guards reject bearer tokens.
- `PennyPlanningVideo` not ported (no video asset in the native bundle); the
  caption bubble still posts.
- Truncated-plan card says "Click below to keep going…" — verbatim web copy,
  wrong word on a phone. Fix on both clients.
- Web Settings copy still mentions drive caps / water cadence; those fields are
  no longer collected. Stale on both sides now, flagged in comments.
