/**
 * Central app config.
 *
 * API_BASE_URL — the deployed Next.js backend (web app). The mobile app is a
 * pure client of the existing API routes; it has no backend of its own.
 *
 * Set per environment via EXPO_PUBLIC_API_URL:
 *   - local dev against `npm run dev` in the repo root: http://localhost:3000
 *     (use your Mac's LAN IP, e.g. http://192.168.x.x:3000, when running on a
 *     physical device — localhost on-device points at the phone itself)
 *   - TestFlight/production: the prod Vercel URL
 */
export const API_BASE_URL: string = process.env.EXPO_PUBLIC_API_URL ?? "";
