#!/usr/bin/env node
/**
 * Re-capture the live Nominatim payloads the reverse-geocode tests run against.
 *
 *   node scripts/capture-nominatim-fixtures.mjs
 *
 * Writes `src/lib/osm/__fixtures__/nominatim-reverse.json` (one point per
 * country shape) and, with `--route`, `src/lib/penny/__fixtures__/girona-annecy.json`
 * (the reported trip's geometry plus a reverse answer at every polyline index
 * within 30 km of the planned split).
 *
 * WHY A SCRIPT AND NOT HAND-WRITTEN OBJECTS. The tests these feed used to
 * assert against `{ city: 'Girona', country: 'Spain' }`, which Nominatim has
 * never returned for Girona — it returns `state: 'Catalunya', country:
 * 'España'`. The fabricated payload passed while the code it was meant to cover
 * was broken, and "Tavel, Occitania" reached a real itinerary. A fixture whose
 * shape is guessed tests the author's memory of the API.
 *
 * Free, unauthenticated, and bound by Nominatim's policy: identifying
 * User-Agent, at most 1 request per second. Both are honoured below. Do not
 * parallelise this.
 *
 * The route geometry comes from OSRM's public demo server, which is TEST-ONLY:
 * production routes on Google Directions (paid). It is used here so that
 * regenerating a fixture never spends money.
 */

import { writeFile } from 'node:fs/promises';

const UA =
  process.env.NOMINATIM_USER_AGENT ?? 'FeralTravels/1.0 (+https://www.feraltravels.com)';
const MIN_INTERVAL_MS = 1_150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One point per address shape we care about, not per country we support. */
const POINTS = [
  ['tavel_fr_village', 44.0119, 4.6986, 'en'],
  ['annecy_fr_city', 45.8992, 6.1294, 'en'],
  ['orange_fr_town', 44.146, 4.776, 'en'],
  ['girona_es_city', 41.9794, 2.8214, 'en'],
  ['girona_es_no_accept_language', 41.9794, 2.8214, null],
  ['modena_it_city', 44.6471, 10.9252, 'en'],
  ['modena_it_no_accept_language', 44.6471, 10.9252, null],
  ['amarillo_us_city', 35.222, -101.8313, 'en'],
  ['marfa_us_town', 30.3093, -104.0208, 'en'],
  ['dortmund_de_city', 51.5136, 7.4653, 'en'],
  ['bergen_no_city', 60.3913, 5.3221, 'en'],
  ['monument_valley_us_remote', 36.998, -110.0985, 'en'],
  ['singapore_sg', 1.3521, 103.8198, 'en'],
  ['atlantic_ocean', 40.0, -30.0, 'en'],
];

async function reverse(lat, lon, lang) {
  let url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}` +
    `&zoom=10&addressdetails=1`;
  if (lang) url += `&accept-language=${lang}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} for ${lat},${lon}`);
  return res.json();
}

const R = 6371.0088;
const haversineKm = (a, b) => {
  const [la1, lo1] = a;
  const [la2, lo2] = b;
  const p1 = (la1 * Math.PI) / 180;
  const p2 = (la2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lo2 - lo1) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

async function capturePoints() {
  const points = {};
  for (const [key, lat, lon, lang] of POINTS) {
    let j = {};
    try {
      j = await reverse(lat, lon, lang);
    } catch {
      /* a point in the ocean answers with no address; keep the empty shape */
    }
    points[key] = {
      query: { lat, lon, accept_language: lang },
      name: j.name ?? null,
      address: j.address ?? {},
    };
    console.log(`${key.padEnd(30)} ${j.name ?? '(none)'}`);
    await sleep(MIN_INTERVAL_MS);
  }
  const out = {
    _README:
      'Captured from live Nominatim by scripts/capture-nominatim-fixtures.mjs. Do NOT hand-write entries here: the payload shape is the whole point of the file.',
    points,
  };
  await writeFile('src/lib/osm/__fixtures__/nominatim-reverse.json', JSON.stringify(out, null, 2) + '\n');
  console.log('\nwrote src/lib/osm/__fixtures__/nominatim-reverse.json');
}

async function captureRoute() {
  // Girona -> Annecy: the trip reported on 2026-09-21.
  const url =
    'https://router.project-osrm.org/route/v1/driving/2.8214,41.9794;6.1294,45.8992' +
    '?overview=full&geometries=geojson';
  const route = (await (await fetch(url, { headers: { 'User-Agent': UA } })).json()).routes[0];

  // Downsample to ~1 point per 3 km: enough geometry for the snap to be real,
  // small enough to read in a diff.
  const full = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const poly = [full[0]];
  let acc = 0;
  for (let i = 1; i < full.length; i++) {
    acc += haversineKm(full[i - 1], full[i]);
    if (acc >= 3 || i === full.length - 1) {
      poly.push(full[i].map((n) => Math.round(n * 1e5) / 1e5));
      acc = 0;
    }
  }

  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + haversineKm(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1];
  const planned = cum.findIndex((k) => k >= total * 0.5);
  const lo = cum.findIndex((k) => k >= cum[planned] - 30);
  let hi = cum.findIndex((k) => k >= cum[planned] + 30);
  if (hi < 0) hi = cum.length - 1;

  const lookups = {};
  for (const i of [...Array(hi - lo + 1).keys()].map((n) => n + lo).concat(poly.length - 1)) {
    const j = await reverse(poly[i][0], poly[i][1], 'en');
    lookups[String(i)] = { name: j.name ?? null, address: j.address ?? {} };
    console.log(`  idx ${i} ${j.name ?? '(none)'}`);
    await sleep(MIN_INTERVAL_MS);
  }

  const out = {
    _README:
      'Girona -> Annecy, the trip reported on 2026-09-21. Route geometry from OSRM (free, TEST-ONLY; production uses Google Directions), downsampled to ~1 point per 3 km. `lookups` are live Nominatim reverse answers keyed by polyline index, for every index within 30 km of the planned split, plus the destination. Regenerate with `node scripts/capture-nominatim-fixtures.mjs --route`.',
    polyline_points: poly,
    total_distance_km: Math.round(route.distance / 100) / 10,
    total_drive_time_minutes: Math.round(route.duration / 60),
    planned_split_index: planned,
    lookups,
  };
  await writeFile('src/lib/penny/__fixtures__/girona-annecy.json', JSON.stringify(out) + '\n');
  console.log('\nwrote src/lib/penny/__fixtures__/girona-annecy.json');
}

if (process.argv.includes('--route')) await captureRoute();
else await capturePoints();
