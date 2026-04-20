import 'server-only';
import type { FindSpotsInput, OvernightSpot } from './types';

// Park4Night does not expose a free public API. Their app talks to a private
// backend that requires an authenticated client token. Rather than scrape and
// invite a TOS fight, we keep this source as an opt-in that returns no rows
// when no key is configured. The orchestrator falls back to iOverlander +
// Google Places, which together cover the same data well enough for v1.
//
// To enable a real backend later, set PARK4NIGHT_API_BASE + PARK4NIGHT_API_KEY
// and implement the fetch here.
export async function fetchPark4NightSpots(_input: FindSpotsInput): Promise<OvernightSpot[]> {
  const base = process.env.PARK4NIGHT_API_BASE;
  const key = process.env.PARK4NIGHT_API_KEY;
  if (!base || !key) return [];
  // Placeholder: fall back to no results until a real client is implemented.
  return [];
}
