/**
 * Central app config.
 *
 * API_BASE_URL — the deployed Next.js backend. Defaults to PRODUCTION
 * (feraltravels.com) in every build; the mobile app is a pure client of the
 * existing API routes and has no backend of its own.
 *
 * Override ONLY for local development against `npm run dev`:
 *   EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo start --ios
 *   (use your Mac's LAN IP instead of localhost on a physical device)
 */
// NOTE: www is the CANONICAL host — bare feraltravels.com answers with a
// redirect page ("Redirecting..."), which native fetch handles poorly for
// POSTs. Always use www here.
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ?? "https://www.feraltravels.com";
