/**
 * Quick check that leg fuel stops (including source=penny) produce waypoints= in Maps URLs.
 * Run: npx tsx scripts/verify-maps-waypoints.ts
 */
import { buildLegDirectionsUrl, legDirectionsWaypoints } from '../src/lib/maps';

const stops = [
  {
    lat: 43.0,
    lng: 3.1,
    status: 'option',
    stop_type: 'fuel',
    source: 'penny' as const,
    distance_from_start_km: 200,
    sort_order: 1,
  },
  {
    lat: 46.0,
    lng: 2.0,
    status: 'option',
    stop_type: 'fuel',
    source: 'google_places' as const,
    distance_from_start_km: 450,
    sort_order: 2,
  },
];

const wps = legDirectionsWaypoints(stops);
if (wps.length !== 2) throw new Error(`expected 2 waypoints, got ${wps.length}`);

const url = buildLegDirectionsUrl({
  legCoords: {
    start_lat: 41.98,
    start_lng: 2.82,
    end_lat: 52.52,
    end_lng: 13.405,
  },
  stops,
});
if (!url) throw new Error('expected URL');
const u = new URL(url);
if (!u.searchParams.get('waypoints')) throw new Error(`missing waypoints in ${url}`);
if (u.searchParams.get('dir_action') === 'navigate') {
  throw new Error('expected preview mode (no dir_action) when waypoints exist');
}
console.log('verify-maps-waypoints: ok');
console.log(url);
