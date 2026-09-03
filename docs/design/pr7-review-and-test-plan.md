# PR #7 — `feat/native-oauth` — what merged, what to verify, what to test next

> **Status (2026-08-20):** Parts 1-3 are a record of what PR #7 shipped and what
> it left uncovered — still accurate. **Part 4 is largely DONE:** Tier 1 and
> Tier 2 landed in PR #9 (`oauthReplay` unit tests, the error-copy guard,
> `legal-pages` and `oauth-exchange` e2e specs, the deletion read-back endpoint
> and its five specs, and the `cleanupPlaywright` fixture-address fix). Tiers 3
> to 5 are open: the `/admin/deleted` spec, mobile component or Maestro tests,
> and the CI guards. Read Part 4 as a backlog with the top two crossed off, not
> as untouched work.

Merge commit `7601751`, 12 commits, **76 files, +11,435 / −489**. Merged into `main` 2026-08-20.
Diff range used throughout: `git diff 5820cdf 7601751`.

---

## Part 1 — What actually changed

The PR title undersells it. This is four features plus a CI half-pipeline, not one.

### 1.1 Native OAuth for iOS (the headline)

**New server endpoint** `POST /api/mobile/oauth/exchange` (`src/app/api/mobile/oauth/exchange/route.ts`).
The iOS app does the OAuth dance on-device (PKCE with `expo-auth-session` for Google, `expo-apple-authentication` for Apple), then posts the provider **ID token** to this route. The server verifies it and mints the same 30-day bearer session the OTP path already used.

Verification lives in `src/server/auth/oauthIdentity.ts` — deliberately DB-free and Auth.js-free so it is unit-testable:

| Check | Detail |
|---|---|
| Signature | `jose.jwtVerify` against the provider's remote JWKS (cached, rotation-safe) |
| Audience | Google → `AUTH_GOOGLE_IOS_CLIENT_ID` (**not** the web client id). Apple → the bundle id `com.feraltravels.ios` / `APPLE_APP_BUNDLE_ID` |
| Issuer | both Google forms; Apple exact |
| Expiry | jose `exp`/`nbf` with `clockTolerance: 5`, **plus** an explicit refusal of a token with no `exp` at all (otherwise it'd be an immortal bearer credential) |
| Email | must be present and `email_verified` must be `true`/`"true"` |
| Avatar | Google `picture` → `sanitizeAvatarUrl` before it's stored |

**Session minting was unified.** `createSessionForEmail()` in `src/server/auth/otp.ts` is now the single mint for both OTP and native OAuth: find-or-create by `lower(email)`, stamp `emailVerified`, backfill `name` if empty, **refresh** `image` every time, sync the admin flag, insert a `sessions` row (`crypto.randomUUID()`, 30 days).

**New table** `oauth_token_uses` (migration `0023`) — see replay protection below.
**New endpoint** `GET /api/me/identity` → `{email, name, image}` for the caller's own row, re-sanitising the avatar URL on the way out so pre-allowlist rows are filtered with no backfill.

### 1.2 The four real bug fixes in the auth area

1. **Replay** (`f78763a`). Before: verification proved *authenticity*, never *freshness*. Provider ID tokens live ~1h, the iOS client id ships in the app binary and isn't secret, and iOS custom URL schemes aren't exclusive to one app — so one captured token could be redeemed for **unlimited 30-day sessions** until it expired. Fix: `oauthReplay.ts` inserts `sha256(idToken)` into `oauth_token_uses` with `ON CONFLICT DO NOTHING RETURNING`; zero rows back ⇒ `401 TokenAlreadyUsed`. Insert-*first* so two concurrent redemptions race on the primary key inside Postgres rather than in a check-then-act window. Plus 5 exchanges/60s per address ⇒ `429`.
2. **Apple `email_verified` was advisory.** The old code only rejected an explicit `false`. A token that simply *omitted* the claim minted a session for whatever address it carried — and because `createSessionForEmail` links by email onto an existing OTP/Google user *and* stamps `emailVerified`, an unasserted address could inherit a real account. Now an absent claim is refused, with one carve-out: `@privaterelay.appleid.com` (Apple owns and routes that domain). The `endsWith` includes the `@`, so `a@privaterelay.appleid.com.evil.test` is refused — pinned by a test.
3. **The web path didn't enforce the same rule.** Both web providers run `allowDangerousEmailAccountLinking: true` — correct for a proven address, account takeover for an unproven one. `events.signIn` *cannot* enforce it (an event fires after the decision and its return value is ignored). Fix: a real `callbacks.signIn` in `src/server/auth/index.ts` with logic identical to the native rule.
4. **Wrong env var name** (`05dbf23`). The route read `GOOGLE_IOS_CLIENT_ID`; the deployed name everywhere is `AUTH_GOOGLE_IOS_CLIENT_ID`. Effect before the fix: audience `undefined` ⇒ **every Google native exchange returned 503**.

Also: the test suite itself was fixed. Every spec injected a stub verifier, so the suite would have stayed green with real `jwtVerify` replaced by a bare `decodeJwt`. A "real jose verification (not a stub)" block was added that generates an RS256 key set locally and pins that a web-client audience, wrong issuer, foreign key and expired token are all rejected.

### 1.3 Account deletion (App Store 5.1.1(v) requirement)

New on both web (`/settings` → Danger zone) and iOS (Settings → Danger zone). Type-to-confirm `delete account`, validated **server-side** (`src/lib/accountDeletion.ts`, mirrored into `mobile/shared/`).

`POST /api/me/delete` → `deleteUserAccount()` (`src/server/repos/accountDeletion.ts`), one real transaction:

1. Read the user; normalise the email (`users.email` is *not* guaranteed lowercase — the NextAuth adapter writes `profile.email` verbatim).
2. Count trips / vehicles / chat messages, read `accounts.provider` rows.
3. **Insert the `deleted_users` tombstone** — counts, `sign_in_providers`, `account_created_at`, an HMAC-SHA256 email hash and an AES-256-GCM ciphertext of the address.
4. Delete `email_otp_codes`, `oauth_token_uses`, `verificationTokens` by email.
5. `UPDATE usage_events SET error_message = NULL` — this holds the user's own sentences (`penny:user-idea`) and place names from their itinerary (`penny:contiguity-gap`). Order matters: after the user delete, `user_id` is `SET NULL` and the predicate would match nothing.
6. `DELETE FROM users` — cascades to `accounts`, `sessions`, `vehicles`, `trips` (→ legs, costs, stops, routes, chat_history, …), `penny_turns`, dismissals, viewport time.

`usage_events` survive **anonymised**. Everything else goes.

**Crypto** (`src/server/deletedUserCrypto.ts`): `DELETED_USER_ENC_KEY`, 32 bytes hex or base64. HMAC rather than plain SHA specifically because CI publishes a clone of prod data behind a public preview URL and emails are enumerable — a plain digest column would be offline-attackable from a dump. Missing key ⇒ deletion still works, degrades to a bare SHA-256 hash, no readable address, and `/admin/deleted` shows a warning banner. **Rotating the key is irreversible loss.**

New admin page `/admin/deleted`. Migration `0024` also adds four FK indexes (`sessions_user_idx`, `accounts_user_idx`, `usage_trip_idx`, `penny_turns_user_idx`) — cascade fires once per parent row, and those columns were unindexed.

### 1.4 Legal + support pages (App Store / Google brand verification)

New route group `src/app/(legal)/` — parentheses keep it out of the URL, so the paths are exactly `/privacy`, `/terms`, `/support` (those exact strings get pasted into ASC and the Google consent screen). No `auth()` anywhere in the group, so they're anonymous.

- `/privacy` — a real GDPR Art. 13 policy, first person, controller in Spain. Documents both tombstone columns, the anonymised usage rows, every sub-processor (Anthropic, Google, Apple, Resend, Neon, Vercel, OSM/OSRM, Expo), SCCs, retention, AEPD complaint route.
- `/terms` — including the "routing, fuel and range figures are **estimates**" section, which is the liability shield for a nav app.
- `/support` — the mandatory ASC Support URL. Photo + `mailto:support@feraltravels.com`.
- `/login` gains a Privacy · Terms footer ("the one page a reviewer is guaranteed to see").

### 1.5 Avatars: initials are gone

`src/lib/avatarUrl.ts` — `sanitizeAvatarUrl()`: string, ≤512 chars, parses as a URL, `https:` only, no credentials, no port, hostname must end `.googleusercontent.com` (leading dot, so `googleusercontent.com.evil.test` is rejected). Applied **four times**: Google native verify, `createSessionForEmail`, the web `events.signIn` refresh, and `getUserIdentity` on read.

Two states everywhere now — **photo or glyph, never initials**. Web: `AppNavbar` gets an inline SVG `AccountGlyph`, a real `<img>` with `referrerPolicy="no-referrer"` and `onError` → glyph, a "Signed in as" hover/focus tooltip card, and `aria-label="Account menu — signed in as <address>"`. Mobile: new `AccountButton` component (32pt circle, 28pt photo inset, `hitSlop={8}` so the tap target goes 32 → 48pt, `onError` → glyph) used in both the trips list header and `TripHeader`.

Why it needed a server change: the Drizzle adapter writes `image` only at user *creation*, so an OTP-first user who later linked Google never got a photo, and a changed Google photo kept a rotting URL.

### 1.6 Location permission primer

iOS gives you **one** permission prompt, ever. Previously `DeviceLocationProvider`'s mount effect fired it cold the instant a trip opened. Now the mount effect shows *our own* modal (`LocationPrimer.tsx`) and the OS alert is spent only after an in-app "Turn on location".

State machine, persisted to SecureStore key `location.primer.v1`:

- template trip (`promptAllowed=false`) → denied, no prompt, no affordance
- already granted → start watching
- permission exists but `canAskAgain=false` → "open settings" path, primer **not** shown (it would promise an alert that never comes)
- consent `declined` → denied, but the label stays tappable
- consent `accepted` → ask the OS directly, no re-explaining
- no consent recorded → show the primer

Re-entry is via an expanded LegCard's nav block, which becomes `LOCATION OFF — TAP TO TURN ON` / `— OPEN SETTINGS`.

### 1.7 Splash / startup

`preventAutoHideAsync()` at module scope with an 8s safety-net `hideAsync()`. The font-loading fallback view repaints `theme.splash` (`#55346F`) instead of cream, matching `expo-splash-screen.backgroundColor`. The gate screen renders a bare purple `View` and hides the splash in a `requestAnimationFrame` after routing. Net effect a tester sees: purple splash → destination, instead of purple → cream loading screen → destination.

### 1.8 The shared-code mirror was broken and nobody knew

`scripts/sync-shared.mjs` copies 17 DOM-free modules from `src/lib` + `src/types` into `mobile/shared/**`. It used `require('node:fs')` inside an ESM `.mjs` — a `ReferenceError` on the *first* file. **It had never synced anything**; `mobile/shared/` was 16 hand-maintained copies. `npm run check:shared` didn't exist as a script either, despite the file header claiming it did.

Fixing it surfaced a second bug: the `@/components/DeviceLocationContext` → `@/lib/location` rewrite was missing, so the first *working* sync would have overwritten `mobile/shared/lib/useNextStop.ts` with an unresolvable import and broken the mobile build.

The guard is now `src/lib/sharedMirror.test.ts` — imports `SHARED_FILES` and `transform` from the `.mjs` and asserts each destination equals `transform(source)`. Lives in the existing `unit` project, so it gates every PR with no new job.

### 1.9 CI

- **New job "Mobile typecheck"** in `ci.yml` — `npm ci && npx tsc --noEmit` in `mobile/`. Deliberately does **not** gate the preview.
- **New workflow `mobile.yml`** — the mobile half of the deploy. On push to `main` touching `mobile/**`: a `decide` job greps the diff against `^mobile/(app\.config\.js|package\.json|package-lock\.json|eas\.json|assets/)` and picks `eas update` (OTA, seconds) or `eas build --auto-submit` (binary, ~30 min). The OTA job shells out `node -e` to read `build.production.env` out of `eas.json` into `$GITHUB_ENV` first — `eas.json` env is build-only and `EXPO_PUBLIC_*` is inlined at bundle time, so without it an OTA would ship `config.ts`'s fallbacks and **silently delete both social sign-in buttons for every tester**.

### 1.10 New env vars

| Var | Where | Missing ⇒ |
|---|---|---|
| `AUTH_GOOGLE_IOS_CLIENT_ID` | Vercel | every Google native exchange → 503 |
| `APPLE_APP_BUNDLE_ID` | Vercel (optional) | falls back to hardcoded `com.feraltravels.ios` |
| `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET` | Vercel | web Apple button doesn't render. **Secret expires ≤6 months** |
| `DELETED_USER_ENC_KEY` | Vercel prod **and** preview | deletions work, addresses unrecoverable |
| `EXPO_TOKEN` | GitHub secret | Mobile workflow fails — **this is what just happened** |
| `EAS_AUTO_SUBMIT` | GitHub **variable** | builds, never uploads |

Only `DELETED_USER_ENC_KEY` was added to `.env.example`. The other four are documented only in `docs/design/ios-oauth/README-oauth.md`.

---

## Part 2 — Things I'd verify, in priority order

### P0 — will bite you in production or App Review

- [ ] **Vercel prod has `AUTH_GOOGLE_IOS_CLIENT_ID`.** Without it every Google sign-in from the app is a 503. Check the Vercel dashboard, not `.env`.
- [ ] **Vercel prod *and preview* have `DELETED_USER_ENC_KEY`.** It's not in any workflow file — it has to be set by hand in both environments.
- [ ] **Migrations 0023 and 0024 actually applied to prod.** `select count(*) from oauth_token_uses; select count(*) from deleted_users;` should both return 0, not error.
- [ ] **`/privacy`, `/terms`, `/support` return 200 in a logged-out incognito window on `www.feraltravels.com`** — not a login redirect, not a 500. This is the single property that gets you rejected, and nothing tests it.
- [ ] **The support photo loads signed-out** (`/legal/support-dogs.jpg`).
- [ ] **Web Google sign-in still works.** The new `callbacks.signIn` returns `false` (→ an unrecoverable `AccessDenied` dead end) whenever `profile.email_verified` is absent. There is no unit test for that callback. If Auth.js's Apple profile mapping doesn't surface the claim on some flow, **100% of web Apple sign-ins are refused** with a generic banner.
- [ ] **Delete an account on web, end to end**, on a throwaway user with at least one trip. Then check `/admin/deleted` shows the row with a readable address, and query `usage_events` for that user's old id — rows should still exist with `error_message IS NULL` and `user_id IS NULL`.

### P1 — device behaviour, only findable on TestFlight

- [ ] Google sign-in on a real device (the reversed client id is a `CFBundleURLScheme` — it cannot be delivered by OTA, only by this binary).
- [ ] Apple sign-in on a real device with a provisioning profile. Check the first-authorization `fullName` actually lands as the user's name.
- [ ] Apple "Hide My Email" → the `@privaterelay.appleid.com` carve-out path.
- [ ] Cancel each OAuth flow mid-way — should return silently, no error banner.
- [ ] **Sign in twice in a row quickly.** If the second attempt somehow re-submits the same token you'll get `TokenAlreadyUsed`, which is **not in the app's error copy map** — you'll see the generic "Something went wrong."
- [ ] Location primer on a **fresh install**: does the OS alert stay unspent until you tap "Turn on location"?
- [ ] Location primer after **decline → reinstall**. The SecureStore key survives app deletion on iOS, so a returning user may skip the primer and get the cold OS alert.
- [ ] "LOCATION OFF — TAP TO TURN ON" in an expanded LegCard, and the "OPEN SETTINGS" variant after a hard denial.
- [ ] Cold-start splash: purple → destination with **no cream flash and no white flash**. The `requestAnimationFrame` hand-off is a one-frame bet; on a slow cold start it can flash.
- [ ] Google photo appears in the trips-list header and in `TripHeader`. OTP and Apple users get the person glyph, never initials, never "SG".
- [ ] Delete account from the iOS app. **Nothing tests this path at all** — `e2e/account-deletion.spec.ts` is web-only and `mobile/` has no test suite.
- [ ] Type the confirm phrase on a **small** device — the delete dialog has no `KeyboardAvoidingView`, so the input can sit under the keyboard.

### P2 — worth a look before you forget

- [ ] `/admin/deleted` renders, is admin-gated, and shows the "not configured" banner correctly if the key is absent.
- [ ] Avatar hover card on web (mouse and keyboard focus), and that it's suppressed while the menu is open.
- [ ] `npm run sync-shared && git status` — should be clean.
- [ ] `npm run check:shared` passes.

---

## Part 3 — Known problems already in `main`

Ranked by how much they'd cost you.

1. **`oauthReplay.ts` has zero test coverage.** No unit test, no e2e touching `/api/mobile/oauth/exchange`. The single-use guarantee, the insert-before-count ordering and the 429 threshold are all unverified. In a repo with a `noBackdoorGuard` test, this is the conspicuous gap.
2. **A burnt token has no recovery path in the UI.** `consumeIdToken` runs *before* `createSessionForEmail`. If the session insert fails (Neon cold start, DB blip), the ID token is already spent — retrying returns `401 TokenAlreadyUsed`, which isn't in `sign-in.tsx`'s `ERROR_COPY`. And `RateLimited` *is* mapped, but with the **OTP wording**: "A code was already sent recently — please wait 60 seconds before requesting another." Nonsense after tapping Continue with Google.
3. **`docs/design/app-store-listing.md` §6 was stale the moment it merged.** It says "Account deletion. There is no endpoint and no UI. This is a rejection, not a warning" and "Merge and promote `feat/native-oauth` … is NOT in production" — in the same commit that does both. If you work off that doc you'll think you're blocked when you aren't.
4. **`middleware.ts` is dead code, and this PR added comments asserting the opposite.** The app lives in `src/app`, so Next doesn't load a root-level `middleware.ts` at all — CLAUDE.md says exactly that. The pages are public because nothing calls `auth()`, not because of `PUBLIC_PREFIXES`. Benign today; the fix is to correct the comments, not the list. But note that if anyone ever moves the file into `src/`, `/api/me/identity` and `/api/me/delete` are **not** in the list and the app would start receiving HTML login pages.
5. **`sign_in_providers` is wrong for most native users.** The tombstone infers "native-oauth" by probing `oauth_token_uses` for the address — but `pruneExpiredTokenUses` deletes those rows ~1h after sign-in and runs on *every* successful exchange globally. A native user deleting more than an hour after signing in is recorded as `otp`, which is exactly the mislabel the code comment claims to prevent.
6. **`cleanupPlaywright` can now erase an arbitrary address's tombstones on a preview.** `POST /api/test/cleanup` validates `isTestRequestAuthorized` + `z.string().email()` but does **not** call `isFixtureEmail` — unlike `readFixtureOtp`, which does. The comment above it claims "the endpoint only accepts fixture addresses." It doesn't. Test endpoints are hard-off in production, but previews run against a clone of prod data.
7. **No re-authentication on delete.** A stolen session cookie or keychain token plus two words permanently destroys the account. No grace period, no soft-delete, no confirmation email, no rate limit on the route.
8. **No `maxDuration` on `/api/me/delete`.** A heavy user's cascade that exceeds the platform default aborts the transaction, and every retry hits the same wall — a permanently undeletable account. Contrast `replan/route.ts`, which sets 300.
9. **`getIdentity` doesn't set `skipGlobalErrorReport`.** A network failure routes to the **full-screen** error sheet — so opening the trips list offline can throw up a fatal modal caused by an avatar fetch.
10. **`mobile/package.json`'s `sync:shared` script is broken** (`node ../scripts/sync-shared.mjs` with cwd `mobile/`, and the script uses cwd-relative paths). Only the root `npm run sync-shared` works.
11. **Deleting a template owner removes the template for everyone** who cloned from it — anyone with a bookmark gets a 404. No warning in the UI.
12. **Node version split**: `ci.yml` typechecks mobile on node 22; `mobile.yml` builds and publishes it on node 20. The thing that gates and the thing that ships don't run the same toolchain.
13. **A push touching only `.github/workflows/mobile.yml`** matches `paths` but contains no native input ⇒ it publishes an OTA of unchanged JS to production testers.
14. **A PR merged with a red Mobile typecheck publishes an OTA within seconds.** The job doesn't gate, and `mobile.yml` never re-checks CI (unlike `deploy-production.yml`, which does).

---

## Part 4 — New e2e tests

### 4.1 The existing suite's blind spots

`e2e/account-deletion.spec.ts` is 7 solid tests, but:

- **The tombstone is never asserted.** Delete the `INSERT INTO deleted_users` and the whole suite still passes.
- **The `usage_events` scrub is never asserted** — neither that the free text is cleared nor that the rows survive anonymised. That's the actual privacy obligation in the feature, and it's untested.
- **"trips are gone" doesn't prove that.** It asserts `GET /api/trips` → 401, which only proves the *session* died. A version that deleted `sessions` and nothing else passes.
- Only `email_otp_codes` cleanup is checked; `verificationTokens` and `oauth_token_uses` aren't.
- One assertion is `expect(res.ok()).toBe(false)` — a 500 would pass. Should be `expect(res.status()).toBe(403)`.

And nothing anywhere touches `/api/mobile/oauth/exchange`, the legal pages, or `/admin/deleted`.

### 4.2 Proposed — ranked

**Tier 1 — write these before the next merge**

`e2e/legal-pages.spec.ts` — cheapest test in the repo, guards the thing that gets you rejected.
```
for (const path of ['/privacy', '/terms', '/support']) {
  test(`${path} is 200 with no session`, …)   // browser.newContext() with no storageState
}
test('/legal/support-dogs.jpg is 200 signed out')
test('/login footer links to /privacy and /terms')
test('privacy page names account deletion')   // guards against the policy drifting from the code
```

`src/server/auth/oauthReplay.test.ts` (unit, not e2e — needs a DB, so mock the client or add an integration project):
```
- first consume succeeds
- second consume of the same token → UnauthorizedError('TokenAlreadyUsed')
- two concurrent consumes: exactly one wins   ← the insert-first ordering
- 6th exchange for one address inside 60s → HttpError(429)
- a rate-limited token is still consumed (documented behaviour, pin it)
- pruneExpiredTokenUses removes only rows past `expires`
```

`e2e/oauth-exchange.spec.ts` — the route with a *forged* token, asserting the negative space. You can't mint a real Google ID token in CI, but every rejection path is testable:
```
- {} → 400 InvalidRequest
- {provider:'facebook'} → 400
- {provider:'google', idToken:'not-a-jwt'} → 401 InvalidToken
- a locally-signed RS256 JWT with the right shape but a foreign key → 401 InvalidToken
- same, with the web client id as `aud` → 401     ← the confused-deputy case
- same, expired → 401
- same, no `exp` claim → 401
- AUTH_GOOGLE_IOS_CLIENT_ID unset → 503 ProviderNotConfigured
```
The last one needs an env override; if that's awkward on a preview, make it a unit test against the route handler instead. The rest work as plain `request.post` calls against the preview URL — no browser needed.

**Tier 2 — close the deletion gaps**

Extend `e2e/account-deletion.spec.ts`. All of these need a read-back vantage point, so add a test-only endpoint (`GET /api/test/deleted-summary?email=`) behind the same `isTestRequestAuthorized` gate — and while you're in `testSupport.ts`, **add the `isFixtureEmail` check that `cleanupPlaywright` is missing**.
```
- after deletion, deleted_users has exactly one row for the address
  with trip_count / vehicle_count / chat_message_count matching what was seeded
- the row's email_encrypted decrypts back to the address
- usage_events rows survive with user_id NULL and error_message NULL
  (seed one first via a Penny turn that records `penny:user-idea`)
- a real trip id 404s for its old owner's *new* session after re-signup
- verificationTokens and oauth_token_uses for the address are gone
- re-signup with the same email → new user id, zero trips, and the OTP
  cooldown is reset
- the 403 test asserts status 403, not just !ok
```

**Tier 3 — new surfaces**

```
e2e/admin-deleted.spec.ts
  - non-admin → redirect/404
  - admin sees a deletion they just performed, address readable
  - bearer token cannot reach it (admin guards are cookie-only)

src/server/auth/signInCallback.test.ts   (unit)
  - email_verified true / "true" → allow
  - false / "false" → refuse
  - absent + google → refuse
  - absent + apple + @privaterelay.appleid.com → allow
  - absent + apple + @privaterelay.appleid.com.evil.test → refuse
  This is the one that can silently reject 100% of web Apple sign-ins.

src/lib/deleteRoute.test.ts   (unit, or extend the e2e)
  - unparseable body → treated as "did not confirm", never a 500
  - confirm > 64 chars → 403
  - admin self-delete blocked when VERCEL_ENV=production
```

**Tier 4 — mobile, the real hole**

`mobile/` has **no test suite at all** — CI runs `tsc --noEmit` and that's it. An OTA puts whatever compiles on devices in seconds. Two options, in increasing cost:

1. **Component specs with `@testing-library/react-native`** + a vitest/jest project in `mobile/`, added to the CI matrix. Highest value per hour on:
   - `LocationPrimer` / `location.tsx` — the whole `promptAllowed × permission × canAskAgain × persisted-consent` matrix, with SecureStore and `expo-location` mocked. This is a pure state machine and it's the single most branch-heavy thing in the app.
   - `DeleteAccountSection` — phrase gate, the `inFlight` ref against a double-tap, error rendering, and that `clearToken` runs before the redirect.
   - `AccountButton` — photo → glyph on `onError`, glyph for null image, accessible label.
   - `sign-in.tsx` `messageFor` — feed it every server error code including `TokenAlreadyUsed` and assert none falls through to the generic string. That test fails today, which is the point.
2. **Maestro flows** (cheaper to write than Detox, runs on EAS Build): cold start → sign-in screen; sign in; open a trip → primer appears → decline → LegCard shows "LOCATION OFF"; Settings → delete account → back at sign-in.

**Tier 5 — CI guards, not tests**

```
- a check that every server env var read in src/server/** appears in .env.example
  (would have caught all four missing ones)
- make Mobile typecheck a required check, or have mobile.yml refuse to publish
  when the merge commit's CI run is red — right now a red typecheck still ships an OTA
- align node versions: 22 in ci.yml vs 20 in mobile.yml
- a scheduled job that warns 30 days before AUTH_APPLE_SECRET's ~6-month expiry
```

### 4.3 What I'd do first

If you only do three things: **the legal-pages spec** (10 minutes, guards a rejection), **`oauthReplay` unit tests** (the security property this PR was written for is completely unverified), and **the `sign-in.tsx` error-copy test** (it fails today and it's a one-line fix).
