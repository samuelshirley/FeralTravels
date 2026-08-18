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
export const GOOGLE_IOS_CLIENT_ID: string | null =
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? null;

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
