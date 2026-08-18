# Native OAuth — what Sam has to create

The mobile sign-in screen and `mobile/lib/oauth.ts` are done. They will not work
until these five things exist.

## 1. Google Cloud: an **iOS** OAuth client ID

Console → APIs & Services → Credentials → Create credentials → OAuth client ID →
**iOS**, bundle id `com.feraltravels.app`.

This is a *second* client, separate from the existing web `AUTH_GOOGLE_ID`.
Google refuses the native flow from a web client, and the exchange route rejects
any token whose `aud` is not the iOS client.

Then set, in both places:

- `.env` (Vercel, server): `GOOGLE_IOS_CLIENT_ID=<id>.apps.googleusercontent.com`
- mobile `.env` / EAS secret: `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<same value>`

Until the Expo var is set, the app hides the Google button rather than showing a
dead one.

## 2. Reversed-client-id URL scheme in `app.json`

Google redirects to the client id with its dot-parts reversed. Add it or the
browser has nowhere to hand the result back to:

```json
{
  "expo": {
    "ios": {
      "bundleIdentifier": "com.feraltravels.app",
      "infoPlist": {
        "CFBundleURLTypes": [
          { "CFBundleURLSchemes": ["com.googleusercontent.apps.<id>"] }
        ]
      }
    }
  }
}
```

`<id>` is the part before `.apps.googleusercontent.com`. Full scheme example:
`123456-abcdef.apps.googleusercontent.com` → `com.googleusercontent.apps.123456-abcdef`.

## 3. Sign in with Apple entitlement

- `app.json`: `"ios": { "usesAppleSignIn": true }` and add
  `"expo-apple-authentication"` to `plugins`.
- Apple Developer → Identifiers → `com.feraltravels.app` → enable
  **Sign in with Apple**, then regenerate the provisioning profile
  (`eas credentials`).

Required, not optional: App Store Guideline 4.8 rejects an app that offers
Google sign-in without it.

## 4. `npm i jose` in the web repo

Used by the exchange route to verify ID tokens against the provider JWKS.

## 5. Wire up the exchange route

- Copy `oauth-exchange-route.ts` → `src/app/api/mobile/oauth/exchange/route.ts`.
- Extract `createSessionForEmail(email, name?)` out of `signInWithOtpCore()` in
  `src/server/auth/otp.ts` and export it; make `signInWithOtpCore` call it too,
  so OTP and OAuth mint identical session rows. See the TODO at the top of the
  route.
- Check that route's `errorResponse` / `HttpError` / `UnauthorizedError` calls
  match the real signatures in `@/server/auth/guards` — they were written
  against the names only, not the source.

## Apple provider on web (optional, later)

If Apple sign-in should also work on feraltravels.com, add the Auth.js Apple
provider: a Services ID, a `.p8` key, and `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET`.
Not needed for the app — the native flow does not go through Auth.js.
