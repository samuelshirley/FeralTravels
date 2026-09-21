# Conventions — the long form

> Moved out of `CLAUDE.md` on 2026-09-20, verbatim, when that file was cut from
> 225 KB back to a map. Nothing here was rewritten or deleted — only relocated.
> `CLAUDE.md` links here from the one-line summary that replaced it.

`CLAUDE.md` keeps the load-bearing conventions as one line each. This file keeps the
incident behind each one, which is the part that stops it being re-broken.

## Conventions

- **Copy rule.** Every string on screen must tell the user something they cannot
  already see. No explanatory paragraphs under a control whose label already
  explains it, no reassurance filler ("Restoring never charges you again"), no
  restating a button in a sentence. If a control needs a paragraph to be
  understood, the control is wrong — fix the control. Status lines state a fact
  (what plan, which date, what happens next); they do not sell, apologise or
  reassure. The exception is a DESTRUCTIVE action, where enumerating what is
  destroyed is information rather than filler — the "Delete account" paragraph
  stays. Applied to the Settings screen 2026-09-02; the rest of the app is
  unswept, so expect to find more.
- No `any` types. Use Zod schemas for API input validation.
- CSS Modules for component-scoped styles (e.g., `admin.module.css`).
- Server components by default; `"use client"` only when needed.
- Env vars: copy `.env.example` to `.env`. Never commit `.env`.
- **Google Maps: there is exactly ONE API key — `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.** It is used for BOTH the browser Maps JS and every server-side Google REST call (Directions, Geocoding, Places). `GOOGLE_MAPS_SERVER_API_KEY` and the `src/server/google-maps-server-key.ts` helper are dead scaffolding — that env var is NOT set in Vercel, so the helper always falls back to the one public key. Do NOT assume a separate server key exists; do NOT propose "use the server key" as a fix. (This has confused past assistants repeatedly — hence this note.)
- Admin access: hardcoded allowlist in `src/server/auth/admin.ts`.
- **A phone's reload renders the phone's tree first (item 8, 2026-09-04).** Two changes, and the second is what made the first matter. (1) `TripWorkspace` now receives the trip the page already fetched (`initialTrip` / `initialPois` from `getTripFull` + `getPoisForTrip`) and renders its real tree on the server instead of a second spinner — every load used to paint Next's `loading.tsx` spinner, THEN the workspace's own loading branch, THEN content, which is the "flash, then flash again" as reported; the two-spinner sequence, not a viewport swap, was the visible part. (2) With the tree now server-rendered, WHICH tree matters: `useMediaQuery` still must not read `matchMedia` during render (the hydration-error bug), so its initial value comes from a HINT the server also knew — the `tp-viewport` cookie (`lib/viewportHint.ts`), written before first paint by a blocking inline script in `app/layout.tsx` and read by `ViewportHintFromCookie` on the three dynamic pages that render viewport-dependent trees. Measured in `e2e/viewport-hint.spec.ts`, which samples the workspace root every animation frame on a 430px Chromium: with the hint ignored a reload paints `desktop → mobile`; with it, `mobile` alone. Deliberately NOT in the root layout: `cookies()` would make the anonymous legal pages dynamic. A fresh browser's very first visit (no cookie yet) still does the one swap. The breakpoints live in `lib/breakpoints.ts`, a plain module — a server component importing them from the `'use client'` hook got a client reference and 500'd every page. The `useMediaQuery` comment that called the swap "sub-frame and invisible" is gone.
- **Every "go here" is a drive, not a pin (item 10, 2026-09-04).** Stop rows (web `<a>`, native `Pressable` — the WHOLE row, with the `×` remove control a sibling outside it), the NEXT STOP button, StopCard and the native map sheet all link through `buildGoHereUrl` → `/maps/dir/?api=1&destination=…&travelmode=driving&dir_action=navigate`, no `origin` (Maps routes from the device). `goHereLinksGuard.test.ts` + `StopsSection.test.tsx` guard it.
- **A server module never CALLS a value imported from a `'use client'` module (2026-09-08).** Rendering a client COMPONENT from a server component is the whole point and stays legal; calling one of its plain exports is not. In the RSC graph every export of a `'use client'` module compiles to a client-reference proxy, so the call throws `TypeError: <name> is not a function` when the page renders — invisible to `tsc` (the types are right, only the runtime binding is wrong), invisible to the jsdom component specs (everything is a client there), and invisible in `next dev` until the page is requested. **The incident:** `buttonStyle` was a plain helper exported from `components/ui/Button.tsx`, which is `'use client'`; `app/settings/page.tsx` is a server component and called it inside its `{admin && ...}` block. `/settings` 500'd on production with digest `1097810709` from 2026-09-03 — twelve minutes after `Button.tsx` gained its directive — until 2026-09-08, and only the admin could reach the branch, so nothing noticed for five days. The build output named it outright: the settings server bundle held `createProxy(...ui/Button.tsx#buttonStyle)` where the function should have been. **The fix is structural**: the recipe (`ButtonVariant`, `BASE`, `VARIANTS`, `buttonStyle`) lives in `components/ui/buttonStyle.ts`, which carries no directive, and all nine call sites import from there. `Button.tsx` deliberately does **not** re-export `buttonStyle` — a re-export moves the footgun rather than removing it, since importing it from the client module would still yield a proxy. `serverClientBoundaryGuard.test.ts` walks `src/app` + `src/server`, resolves each import to a file, and fails on any non-directive module that calls a binding from a `'use client'` one. It blanks spread dots before the call check, and that is not a detail: `...buttonStyle('secondary')` — the exact shape of the bug — puts a `.` immediately before the name, and the first draft of the guard read it as a method call and passed the mutation test. Mutation-check any change to it by putting the helper back behind the boundary.
- **An imperial user sees miles and no kilometres anywhere (item 11, 2026-09-04).** Reversed at the source (`formatKmDual`, `Distance`, native `Distance` in `ui.tsx`), and every rendered distance goes through `formatKm`/`approxDistance`/`Distance`; `noHardcodedUnitsGuard.test.ts` makes a `km`/`mi` literal beside a number in a component a suite failure. The "teach metric" comments are deleted.
- **Settings → Location is a switch, and honest about the direction a platform cannot do (item 12, 2026-09-04).** Web: off→on calls `request`; on is checked + disabled with a sentence naming the address-bar control (a page cannot revoke its own permission). Native: both flips reach iOS — `requestForegroundPermissionsAsync` or `Linking.openSettings()` — and the row re-reads on foreground. `LocationSection.test.tsx` (web) and `mobile/maestro/settings-location.yaml` (device, branching on the hint text under the switch) cover it.
- **The native keyboard container belongs at the SCREEN root, never inside `ChatPanel` (2026-08-27).** `KeyboardAvoidingView` lives in `mobile/app/trips/[tripId].tsx`, wrapping header + panes + `BottomNav`. It cannot live in `ChatPanel`: RN's KAV compares its own `onLayout` frame, which is **parent-relative**, against the keyboard's **screen-relative** `screenY`, and those only agree at the window origin. ChatPanel renders inside `styles.pane` (`absoluteFillObject`), so its frame read `y: 0, height: <panes height>` — add them and the sum sat a header-plus-nav *above* the keyboard's top edge, so `Math.max(frameBottom - keyboardY, 0)` clamped to **zero**. No padding was applied at all, which is why the composer was entirely behind the keyboard rather than merely crowded (the "can't see what I'm typing" bug). `headerShown: false` for this route, so no `keyboardVerticalOffset` is needed at the root — but anything that re-parents the KAV below the window origin reintroduces the bug and must pass one. **Related invariant: `ChatPanel` never adds `insets.bottom`.** Its host owns the bottom safe area — `BottomNav` already pads it — and adding it in both places counted the home indicator twice, which was the visible gap between the composer and the nav. `composerWrap`/`readonlyBar`/`setupLoading` are a flat `paddingBottom: 12`; when the keyboard is up the nav unmounts, but the keyboard covers the home indicator itself, so 12 stays right in both states.
- **The account avatar has exactly two states — photo or glyph, never initials (2026-08-20).** Google profile photo when the account has one, generic person glyph otherwise. Web: `src/components/AppNavbar.tsx` (`AccountGlyph`). Native: `mobile/components/AccountButton.tsx` + `AccountIcon` in `mobile/components/icons.tsx` — one component for both the trips list and TripHeader. **Apple never yields a photo** (its ID token has no `picture` claim, ever), so Apple-only users are permanently on the glyph; that is Apple's token, not a gap. Initials are gone: identity on screen for no value, and a `<Text>` centres on the font's line box rather than the glyph, so Onest ExtraBold sat visibly high in the 32pt iOS circle. Every avatar URL passes `sanitizeAvatarUrl` (`src/lib/avatarUrl.ts`) — https, `*.googleusercontent.com` only, no credentials/port — on the way IN (both sign-in paths) and again on the way OUT (`getUserIdentity`, so rows written before the rule existed are filtered without a backfill). Both platforms fall back to the glyph on image load error, because a Google avatar URL rots when the user changes their picture. Tests: `avatarUrl.test.ts`, `AppNavbar.test.tsx`, the photo block in `oauthIdentity.test.ts`.
- **`users.image` is written on EVERY Google sign-in, both paths.** Native: `createSessionForEmail(email, name, image)` (`auth/otp.ts`) from the exchange's verified `picture` claim. Web: `events.signIn` in `auth/index.ts` — the Drizzle adapter only writes `image` at user *creation*, so without that hook a user who signed in by emailed code first and linked Google later never got a photo. Refreshed (not just backfilled) unlike `name`, which the user may have edited. An OTP sign-in passes no image and never wipes one. Deleted with the user row by the account-deletion flow.
- **The address is surfaced deliberately, not baked into the avatar:** a "Signed in as" card under the web button on hover AND keyboard focus (replacing the old native `title` tooltip, which did neither well), and a "SIGNED IN AS" row atop the account menu on web, the trips list and TripHeader.
- **Never silently swallow errors.** Every mutation must either show inline error UI or go through the global `ErrorNotifier`. No empty `catch` blocks, no `console.error`-only handling. If something fails, the user must know.
- **A database failure is not a sign-out (2026-09-08).** `auth()` in
  `src/server/auth/index.ts` is a WRAPPER around Auth.js's own, and the wrapper
  is the fix: Auth.js catches an adapter throw, logs `SessionTokenError` and
  returns `null` — the same value a signed-out visitor produces — so a Neon blip
  presented as a silent site-wide sign-out, thirteen pages deep, via their
  identical `if (!session?.user) redirect('/login')`. The wrapper tells the two
  apart with evidence already on the request: no session cookie means genuinely
  signed out; a cookie with no session means either the row is gone or the store
  is unreachable, and `assertSessionStoreReachable` (`auth/sessionStore.ts`)
  re-runs the exact query Auth.js failed at to find out. Unreachable throws
  `SessionStoreUnavailableError` — **503, never 401**, because
  `mobile/lib/api.ts` clears the keychain on 401 and would sign every iOS user
  out of their device over a database hiccup. Pages surface it through
  `src/app/error.tsx` (the app's only error boundary; it branches on the error's
  `digest`, which is what survives Next's production message redaction), API
  routes through `errorResponse`. **`rawAuth` is the unwrapped escape hatch and
  belongs to `/login` and `/login/verify` only** — they call it purely to bounce
  an already-signed-in visitor, and should render their form during an outage
  rather than an error screen. `src/lib/signOutOnFailureGuard.test.ts` fails the
  suite if anything else imports `rawAuth`, or if the bearer lookup in
  `guards.ts` gains a `catch` that would turn its 500 into a keychain-clearing
  401. The wrapper costs nothing on the signed-in path and one cookie read when
  signed out; the query runs only for a cookie with no session.
- **An unreachable provider is not a bad token (2026-09-21).** The same mistake
  as the one above, one layer out. `/api/mobile/oauth/exchange` answered a failed
  fetch of Apple's signing keys with 401 `InvalidToken`, the answer a forged
  token gets. On 2026-09-21 Apple's `/auth/keys` was 404ing ~1 request in 5:
  real users were told their sign-in "didn't check out", and
  `e2e/oauth-exchange.spec.ts` passed in a preview whose log showed the failure,
  because the two cases could not be told apart. Now the keys are obtained
  **before** the token is read (`src/server/auth/jwksSource.ts`: retry, then a
  persisted last-known-good set no older than 72h), and if there are none the
  answer is **503 `ProviderUnavailable`**. That is not an oracle, because it is
  decided without looking at the token. Everything that DOES depend on the token
  stays a flat 401 `InvalidToken`, including a stale fallback set that lacks a
  rotated-in key, which fails closed. The app retries the 503 silently
  (`src/lib/oauthExchangeRetry.ts`) before showing copy that blames the
  provider. The e2e forged-token tests assert `401 InvalidToken` exactly, so
  "the verifier had no keys" can never pass as "the verifier refused the
  forgery" again; `.github/workflows/oauth-provider-probe.yml` watches both
  JWKS endpoints and production every 15 minutes. **The general rule:** when a
  dependency fails, say so with a 5xx. Never borrow the code that means the
  caller did something wrong.
- **Every error code an API returns must have copy in every client that calls it.** `src/lib/nativeErrorCopyGuard.test.ts` scans the exchange's call chain (`oauthIdentity.ts`, `oauthReplay.ts`, the route) for thrown codes and fails if one is missing from `ERROR_COPY`/`OAUTH_ERROR_COPY` in `mobile/app/sign-in.tsx`. There is no type across an HTTP boundary that could catch this: `TokenAlreadyUsed` shipped unmapped and showed the generic "Something went wrong" for the one failure a user can fix by tapping the button again. `OAUTH_ERROR_COPY` exists because `RateLimited` means two different things — "your emailed code is already in your inbox" on the OTP path, "you are over the per-address exchange limit" on the OAuth one — so `messageFor` takes a `context` and `runOAuth` is the single call site that passes `"oauth"`.
