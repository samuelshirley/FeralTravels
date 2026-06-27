// OSRM-based directions (free, no API key needed).
//
// Defaults to the public demo server, which is fair-use only and not for a
// production app backend. Set OSRM_ENDPOINT to a self-hosted / paid OSRM base
// URL (e.g. https://osrm.yourhost.com) before driving real traffic. See
// docs/design/finn-fuel-agent.md → "harder / to watch".
export const DEFAULT_OSRM_ENDPOINT = 'https://router.project-osrm.org';

function osrmBase(): string {
  return (process.env.OSRM_ENDPOINT?.trim() || DEFAULT_OSRM_ENDPOINT).replace(/\/+$/, '');
}

interface OSRMRoute {
  distance: number; // meters
  duration: number; // seconds
  geometry: string; // encoded polyline
}

interface DirectionsResult {
  distance_km: number;
  drive_time_minutes: number;
  geometry?: string;
}

export async function getDirections(
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number
): Promise<DirectionsResult | null> {
  try {
    const url = `${osrmBase()}/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=polyline`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes?.length) {
      console.error('OSRM error:', data.code);
      return null;
    }

    const route: OSRMRoute = data.routes[0];
    return {
      distance_km: Math.round(route.distance / 1000),
      drive_time_minutes: Math.round(route.duration / 60),
      geometry: route.geometry,
    };
  } catch (err) {
    console.error('Directions fetch failed:', err);
    return null;
  }
}

// Build a Google Maps URL with all waypoints for navigation
export function buildGoogleMapsUrl(
  waypoints: { lat: number; lng: number; name?: string }[]
): string {
  if (waypoints.length < 2) return '';
  const parts = waypoints.map((w) => `${w.lat},${w.lng}`);
  return `https://www.google.com/maps/dir/${parts.join('/')}`;
}
