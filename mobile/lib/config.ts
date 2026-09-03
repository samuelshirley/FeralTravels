/**
 * Central app config.
 *
 * API_BASE_URL — the deployed Next.js backend. Defaults to PRODUCTION
 * (www.feraltravels.com — the CANONICAL host; the bare apex answers with a
 * 307/308 redirect, and a cross-HOST redirect is where iOS URLSession may drop
 * the Authorization header). The mobile app is a pure client of the existing
 * API routes and has no backend of its own.
 *
 * Override ONLY for local development against `npm run dev`:
 *   EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo start --ios
 *   (use your Mac's LAN IP instead of localhost on a physical device)
 */
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? "https://www.feraltravels.com";

/**
 * Google OAuth iOS client ID (Google Cloud Console → Credentials → iOS).
 * This is NOT the web client in AUTH_GOOGLE_ID — iOS needs its own, and its
 * reversed form must also be in app.json under ios.infoPlist CFBundleURLTypes.
 * Sign-in with Google is hidden when this is unset rather than showing a
 * button that dead-ends.
 */
const rawGoogleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim();
export const GOOGLE_IOS_CLIENT_ID: string | null = rawGoogleIosClientId
  ? rawGoogleIosClientId
  : // An EMPTY string has to collapse to null too, not just an absent var: an
    // `env` key declared in eas.json with no value inlines as "" at build
    // time, and `?? null` would keep it — showing the button, then failing at
    // the redirect with an unregistered client id. Same trap as the empty
    // googleMapsApiKey that renders a grey rectangle.
    null;

/** Google Maps SDK key for react-native-maps (iOS uses Apple Maps by default). */
export const GOOGLE_MAPS_API_KEY: string | null =
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? null;

/**
 * Sign in with Apple is OFF unless explicitly enabled.
 *
 * `AppleAuthentication.isAvailableAsync()` returns true on ANY iOS 13+ device
 * or simulator — it reports OS capability, NOT whether this app is set up for
 * it. Gating on that alone put a button on screen for a provider with no Apple
 * Services ID, no NextAuth Apple provider, and no entitlement: it could only
 * ever fail. Same flag drives the entitlement in app.config.js, so the button
 * and the capability cannot disagree.
 *
 * Guideline 4.8 makes this MANDATORY before App Review — but only once the app
 * actually offers Google. Turning it on is a real setup task, not a flag flip:
 * see docs/design/ios-oauth/README-oauth.md.
 */
export const APPLE_SIGNIN_ENABLED: boolean =
  process.env.EXPO_PUBLIC_ENABLE_APPLE_SIGNIN === "1";

/**
 * RevenueCat's PUBLIC Apple SDK key (`appl_…`).
 *
 * Public by design — it identifies the app to RevenueCat and grants nothing on
 * its own; every entitlement decision is made server-side from the webhook. It
 * belongs in the bundle, which is why it is an `EXPO_PUBLIC_` var.
 *
 * The empty-string collapse is the same trap as GOOGLE_IOS_CLIENT_ID above, and
 * it bites harder here: an `env` key declared in eas.json with no value inlines
 * as `""` at build time, `?? null` would keep it, and `Purchases.configure`
 * with an empty key produces a configured SDK that returns no offerings — which
 * is indistinguishable, from inside the app, from the Paid Applications
 * Agreement not being signed. Collapsing it to null instead means the app knows
 * purchasing is not wired up and SAYS so, which is the one thing that tells
 * those two failures apart.
 *
 * Unset is a supported state: `mobile/lib/purchases.ts` no-ops, the purchase
 * sheet renders prices without a buy button, and the allowlisted test-purchase
 * path still works. That is exactly the state every build before this one was
 * in.
 */
const rawRevenueCatKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY?.trim();
export const REVENUECAT_IOS_KEY: string | null =
  // The `appl_` prefix is RevenueCat's own, and requiring it does two jobs.
  //
  // It makes `eas.json`'s REPLACE_WITH_… placeholder behave as UNSET rather
  // than as a key: the alternative is `configure()` succeeding with nonsense
  // and every offering coming back empty, which is exactly the symptom of the
  // Paid Applications Agreement not being signed — two completely different
  // problems presenting as the same blank sheet, which is the failure
  // docs/design/iap-setup.md exists to stop.
  //
  // And it catches the two wrong keys that are easy to grab from the same
  // dashboard page: the Android key (`goog_`), and the SECRET API key, which
  // must never be in a client bundle at all.
  rawRevenueCatKey?.startsWith("appl_") ? rawRevenueCatKey : null;

/**
 * The RevenueCat entitlement identifier both products hang off.
 *
 * Hardcoded rather than configurable because it must match three places that
 * cannot check each other: the RevenueCat dashboard, `webhook.test.ts`'s
 * fixtures (`entitlement_ids: ['pro']`), and this app. An env var would let
 * them disagree silently — and a disagreement here means `restorePurchases`
 * reports "nothing to restore" to somebody who is paying.
 */
export const REVENUECAT_ENTITLEMENT_ID = "pro";
