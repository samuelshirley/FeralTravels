import 'server-only';
import type { FindSpotsInput, OvernightCategory, OvernightSpot } from './types';

// iOverlander has no official public API. Their site exposes a JSON endpoint
// at /places.json that the front-end uses for map tiles. We hit that endpoint
// politely (low cardinality, cached server-side) and accept that it might
// change shape — failures are swallowed by the orchestrator.
const IOVERLANDER_BASE = 'https://www.ioverlander.com/places.json';

// Categories on iOverlander we treat as legitimate free overnight options.
// Numeric ids are stable on the site as of 2024-2025; the textual `category`
// field on responses is what we actually filter on so changing ids is safe.
const ALLOWED_TEXTUAL_CATEGORIES = new Set<string>([
  'Wild Camping',
  'Informal Campsite',
  'Established Campground', // included only if marked free below
  'Refuelling/Petrol Station', // sometimes flagged as overnight-friendly
  'Rest Area / Picnic Area',
  'Pull-off / Scenic Area',
]);

interface IoPlace {
  id?: number | string;
  name?: string;
  latitude?: number | string;
  longitude?: number | string;
  category?: string;
  description?: string;
  cost?: string | number | null;
  url?: string;
}

function normalizeCategory(raw: string | undefined): OvernightCategory {
  if (!raw) return 'other';
  const r = raw.toLowerCase();
  if (r.includes('wild')) return 'wild_camping';
  if (r.includes('rest area') || r.includes('pull-off') || r.includes('scenic')) return 'rest_area';
  if (r.includes('aire')) return 'aire';
  if (r.includes('camp')) return 'wild_camping';
  return 'parking';
}

function isFreeFromCost(cost: unknown): boolean {
  if (cost == null) return true; // assume free when missing
  if (typeof cost === 'number') return cost === 0;
  const s = String(cost).trim().toLowerCase();
  if (!s) return true;
  if (s === 'free' || s === '0' || s === '$0' || s === 'no cost') return true;
  // Anything containing a digit > 0 looks paid.
  if (/[1-9]/.test(s)) return false;
  return true;
}

export async function fetchIoverlanderSpots(input: FindSpotsInput): Promise<OvernightSpot[]> {
  // Convert km radius to a rough degrees window for the bbox query.
  // 1 deg lat ≈ 111 km; lng scales with cos(lat).
  const dLat = input.radiusKm / 111;
  const dLng = input.radiusKm / (111 * Math.max(Math.cos((input.lat * Math.PI) / 180), 0.05));
  const swLat = input.lat - dLat;
  const swLng = input.lng - dLng;
  const neLat = input.lat + dLat;
  const neLng = input.lng + dLng;

  const url = new URL(IOVERLANDER_BASE);
  url.searchParams.set('sw[]', String(swLat));
  url.searchParams.set('sw[]', String(swLng));
  // URL only keeps last value; build manually instead.
  const qs = new URLSearchParams();
  qs.append('sw[]', String(swLat));
  qs.append('sw[]', String(swLng));
  qs.append('ne[]', String(neLat));
  qs.append('ne[]', String(neLng));
  qs.append('zoom', '10');

  const fullUrl = `${IOVERLANDER_BASE}?${qs.toString()}`;

  // Let fetch/parse errors propagate to the orchestrator so usage_events logs a
  // real success=false row. Callers higher up catch and fallback gracefully.
  const res = await fetch(fullUrl, {
    headers: {
      'user-agent': 'trip-planner/1.0 (overnight-spot-finder)',
      accept: 'application/json',
    },
    // Don't let upstream hang the request indefinitely.
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`iOverlander HTTP ${res.status} ${res.statusText}`);
  }
  const raw: unknown = await res.json();

  const places: IoPlace[] = Array.isArray(raw)
    ? (raw as IoPlace[])
    : Array.isArray((raw as { places?: unknown })?.places)
      ? ((raw as { places: IoPlace[] }).places)
      : [];

  const out: OvernightSpot[] = [];
  for (const p of places) {
    const lat = typeof p.latitude === 'string' ? Number(p.latitude) : p.latitude;
    const lng = typeof p.longitude === 'string' ? Number(p.longitude) : p.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
      continue;
    }
    if (input.freeOnly !== false && !isFreeFromCost(p.cost)) continue;
    if (p.category && !ALLOWED_TEXTUAL_CATEGORIES.has(p.category)) {
      // Skip hotels, mechanics, restaurants, propane fillers, etc.
      continue;
    }
    out.push({
      source: 'ioverlander',
      sourceId: p.id != null ? String(p.id) : null,
      name: p.name?.trim() || 'iOverlander spot',
      lat,
      lng,
      category: normalizeCategory(p.category),
      isFree: isFreeFromCost(p.cost),
      description: p.description?.trim() || null,
      sourceUrl: p.url
        ? p.url.startsWith('http')
          ? p.url
          : `https://www.ioverlander.com${p.url}`
        : p.id != null
          ? `https://www.ioverlander.com/places/${p.id}`
          : null,
    });
    if (input.perSourceLimit && out.length >= input.perSourceLimit) break;
  }
  return out;
}
