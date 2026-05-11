import 'server-only';

/**
 * Google Places REST calls from Node must not use a browser-only key with
 * HTTP referrer restrictions (Google returns 403). Prefer
 * GOOGLE_MAPS_SERVER_API_KEY — Places API (New) enabled, no referrer
 * restriction (IP restriction is fine for Vercel). Fallback to the public
 * key for local dev / small setups.
 */
export function googleMapsApiKeyForServer(): string | undefined {
  const server = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
  if (server) return server;
  const pub = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  return pub || undefined;
}
