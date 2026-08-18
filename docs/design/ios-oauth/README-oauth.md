# Native OAuth — what's built, and what Sam still has to create

The code is done on both sides. Google sign-in does not appear in the app yet
because **nothing here is a code problem** — the remaining work is three
console tasks and four env vars.

## Why the button is missing (the actual answer)

`mobile/lib/oauth.ts` sets `googleAvailable = GOOGLE_IOS_CLIENT_ID != null`.
With `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` unset, the screen hides the button and
swaps its intro copy — deliberately, because a visible button that always
dead-ends is worse than no button. Set the var, rebuild, and it appears.

## Done in code (nothing to do)

- `POST /api/mobile/oauth/exchange` — verifies a Google or Apple ID token
  against the provider's JWKS and returns the same `{ token, expires, user }`
  the OTP route returns. Verification logic lives in
  `src/server/auth/oauthIdentity.ts` and is unit-tested.
- `createSessionForEmail()` in `src/server/auth/otp.ts` — the single
  find-or-create-user + mint-session path. OTP and OAuth both go through it, so
  the two can never drift.
- `jose` is a dependency.
- Auth.js Apple provider for the **web**, registered only when
  `AUTH_APPLE_ID` + `AUTH_APPLE_SECRET` are both set; the /login button follows
  the same gate.
- `scripts/generate-apple-client-secret.ts` — mints the Apple web secret JWT.
- `scripts/set-ios-oauth-client-id.mjs` — writes the Google iOS client id into
  `mobile/.env` and the EAS build profiles.

## 1. Google Cloud: an **iOS** OAuth client ID

Console → APIs & Services → Credentials → Create credentials → OAuth client ID
→ **iOS**, bundle id `com.feraltravels.app`.

**This is a second, separate client from the web one in `AUTH_GOOGLE_ID`.** Not
a setting on it — a different credential. Google refuses the native PKCE flow
from a web client, and the exchange route rejects any token whose `aud` is not
the iOS client (accepting the web client's token would let any app holding a
Google token for that user sign in as them — there is a unit test pinning
this).

An iOS client ID is **not a secret**: it ships inside the app binary and has no
client secret. Committing it is fine.

Set it everywhere in one shot — with the id on the clipboard, or as an
argument:

```
node scripts/set-ios-oauth-client-id.mjs
```

That writes `mobile/.env` and the `preview` + `production` profiles in
`mobile/eas.json` (EAS does not read an uncommitted `.env`, so cloud builds
need it in the profile). It then prints the two things it cannot do for you.

## 2. The server side, and a NEW native build

- Vercel, **prod and preview**: `GOOGLE_IOS_CLIENT_ID=<the same id>`. The
  exchange route checks the token's `aud` against it; a mismatch is a 401
  `InvalidToken`.
- Rebuild. The client ID's reversed form becomes a `CFBundleURLScheme`
  (`app.config.js` derives it), which is **native config baked into the
  binary** — `eas update` cannot deliver it, and neither can a Metro reload:

```
cd mobile
npx expo prebuild --clean
npx expo run:ios          # or: eas build --profile preview --platform ios
```

## 3. Sign in with Apple entitlement (required before App Review)

Guideline 4.8 rejects an app offering Google sign-in without Sign in with
Apple. Not needed for internal TestFlight, but do it before submission:

- Apple Developer → Identifiers → `com.feraltravels.app` → enable
  **Sign in with Apple**, then regenerate the provisioning profile
  (`eas credentials`).
- Build with `EXPO_PUBLIC_ENABLE_APPLE_SIGNIN=1` — that one flag drives both
  the entitlement in `app.config.js` and the button, so they cannot disagree.

The screen already places the Apple button **above** Google, per Apple's
prominence rule.

## 4. Apple on the web (optional)

Only if `feraltravels.com` should also offer it. The native app does not need
this — it bypasses Auth.js entirely.

- Apple Developer → Identifiers → **Services ID** (e.g. `com.feraltravels.web`
  — NOT the bundle id), Return URL
  `https://www.feraltravels.com/api/auth/callback/apple`.
- Keys → new key with Sign in with Apple enabled → download the `.p8`
  (**one download, ever**).
- Generate the secret — it prompts for the four values:

```
npx tsx scripts/generate-apple-client-secret.ts
```

- Put the printed `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET` in Vercel.

⚠️ **The Apple web secret expires after at most 6 months.** When it lapses,
sign-in fails with a bare `invalid_client` and nothing in the repo has changed.
Put the expiry date the script prints in the calendar.

Note: a user who picks "Hide My Email" arrives as
`<opaque>@privaterelay.appleid.com`. That is a different address from their
real one, so it is a separate account — by design, not a bug.

## Verifying it works

1. `GOOGLE_IOS_CLIENT_ID` set on the preview deployment.
2. New native build with the `EXPO_PUBLIC_` var → button is on the screen.
3. Tap it → Google sheet → back in the app on `/trips`.
4. Sign in on web with the **same** Google account → same trips, one user row.

If the button is there but the tap fails:

| Symptom | Cause |
| --- | --- |
| Browser opens, never returns | reversed-client-id URL scheme missing → `expo prebuild --clean` |
| 401 `InvalidToken` | server `GOOGLE_IOS_CLIENT_ID` ≠ the client the app used |
| 503 `ProviderNotConfigured` | server `GOOGLE_IOS_CLIENT_ID` unset on that deployment |
| 401 `EmailNotVerified` | the Google account's address is genuinely unverified |
