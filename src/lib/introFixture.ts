/**
 * The trip the first-launch intro draws — REAL data, not illustration.
 *
 * WHERE EVERY NUMBER CAME FROM (2026-11-02):
 *
 *  - The ROUTE is the one Penny actually planned for "14 days around Spain's
 *    national parks" from Madrid: trip da203241, captured in
 *    src/lib/finn/__fixtures__/spain-da203241.json — the same overnight towns
 *    and base days, in the same order, under the names it stored.
 *  - DISTANCES, DRIVE TIMES and GEOMETRY were re-measured that day with the
 *    Google Directions API (driving, no avoid flags) between those towns, so
 *    they differ from the fixture's by a few km where the original trip had
 *    pinned slightly different coordinates. The geometry is each leg's
 *    overview polyline, resampled every 12 km for the intro's SVG map.
 *  - FUEL STOPS are Finn's own placement, not a choice made by hand: Places
 *    (New) Text Search along each leg's polyline with Finn's exact request
 *    (`gas station`, includedType gas_station), filtered by
 *    `filterUsableStations` and the 15 km detour cap, projected with
 *    `projectPointOntoRoute` / `alongKmOnLeg`, then the next-day look-ahead
 *    replay from spainTrip.test.ts over `planLegFuelStops`, on the original
 *    trip's 550 km range (the Hilux). Station NAMES are not kept: a fuel stop is
 *    shown as "Fuel stop · 212 km" everywhere (fuelStopLabelGuard.test.ts).
 *  - The day-4 STOP the third screen adds is Castro Urdiales, resolved by
 *    Places Text Search and projected onto that day's route (0.4 km off it).
 *
 * The raw responses are kept beside the design note, outside git:
 * docs/design/first-launch-intro.google-2026-11-02.json.
 *
 * Mirrored to mobile/shared by scripts/sync-shared.mjs — the app cannot import
 * src/server, and this file must stay DOM-free and dependency-light.
 */
import type { ForcedStopReason, PlanSummary } from '@/types/trip';
import { computeArrivalTime, DEFAULT_DAY_MODEL_CONFIG } from '@/lib/dayModel';
import { legDateISO } from '@/lib/dates';

/** What the user types on the first screen. "from Madrid" names the start, so
 *  the real onboarding scan skips its "where are you starting from?" step. */
export const INTRO_EXAMPLE_MESSAGE =
  "I want to take a 2-week trip around Spain's national parks, from Madrid";

/** The vehicle range the fuel stops were placed for, km. */
export const INTRO_RANGE_KM = 550;

export interface IntroFuelStop {
  /** Finn's stored whole-km `distance_from_start_km`. */
  alongKm: number;
  lat: number;
  lng: number;
  reason?: ForcedStopReason;
}

export interface IntroDriveLeg {
  type: 'drive';
  start: string;
  end: string;
  distanceKm: number;
  driveMinutes: number;
  fuel: IntroFuelStop[];
  /** [lat, lng] pairs, start to end. */
  route: Array<[number, number]>;
}

export interface IntroRestLeg {
  type: 'rest';
  title: string;
  /** Where the base day is spent (the previous drive's end). */
  at: string;
}

export type IntroLeg = IntroDriveLeg | IntroRestLeg;

export const INTRO_LEGS: readonly IntroLeg[] = [
  {
    type: 'drive',
    start: "Madrid",
    end: "Monzón de Campos, Spain",
    distanceKm: 270.2,
    driveMinutes: 164,
    fuel: [],
    route: [[40.417,-3.705],[40.467,-3.804],[40.54,-3.891],[40.615,-3.98],[40.664,-4.1],[40.728,-4.194],[40.743,-4.327],[40.791,-4.448],[40.858,-4.553],[40.95,-4.604],[41.035,-4.691],[41.12,-4.767],[41.214,-4.836],[41.308,-4.899],[41.39,-4.961],[41.493,-4.984],[41.555,-4.875],[41.632,-4.777],[41.714,-4.701],[41.792,-4.603],[41.885,-4.534],[41.985,-4.502],[42.091,-4.485],[42.116,-4.494]],
  },
  {
    type: 'drive',
    start: "Monzón de Campos, Spain",
    end: "Cabrales, Spain",
    distanceKm: 241.4,
    driveMinutes: 154,
    fuel: [],
    route: [[42.116,-4.494],[42.21,-4.447],[42.309,-4.399],[42.414,-4.388],[42.519,-4.383],[42.617,-4.35],[42.706,-4.289],[42.79,-4.237],[42.871,-4.15],[42.957,-4.155],[43.042,-4.09],[43.138,-4.064],[43.238,-4.084],[43.329,-4.045],[43.346,-4.127],[43.318,-4.257],[43.357,-4.389],[43.368,-4.522],[43.318,-4.618],[43.304,-4.743],[43.316,-4.846]],
  },
  { type: 'rest', title: "Picos de Europa (base day)", at: "Cabrales, Spain" },
  {
    type: 'drive',
    start: "Cabrales, Spain",
    end: "Vitoria-Gasteiz, Spain",
    distanceKm: 253.7,
    driveMinutes: 175,
    fuel: [{ alongKm: 25, lat: 43.32754, lng: -4.58289 }],
    route: [[43.316,-4.846],[43.317,-4.714],[43.326,-4.588],[43.373,-4.491],[43.344,-4.358],[43.322,-4.222],[43.355,-4.092],[43.328,-3.962],[43.333,-3.834],[43.39,-3.719],[43.412,-3.58],[43.391,-3.446],[43.386,-3.327],[43.373,-3.219],[43.339,-3.115],[43.28,-3.01],[43.214,-2.896],[43.125,-2.921],[43.026,-2.912],[42.961,-2.828],[42.904,-2.711],[42.853,-2.673]],
  },
  {
    type: 'drive',
    start: "Vitoria-Gasteiz, Spain",
    end: "Torla-Ordesa, Spain",
    distanceKm: 273.4,
    driveMinutes: 225,
    fuel: [],
    route: [[42.853,-2.673],[42.877,-2.536],[42.841,-2.405],[42.865,-2.267],[42.892,-2.126],[42.922,-1.99],[42.916,-1.846],[42.856,-1.734],[42.793,-1.684],[42.737,-1.575],[42.678,-1.457],[42.638,-1.334],[42.622,-1.199],[42.621,-1.057],[42.612,-0.919],[42.567,-0.805],[42.562,-0.669],[42.566,-0.527],[42.536,-0.388],[42.61,-0.327],[42.624,-0.231],[42.617,-0.117],[42.698,-0.119],[42.696,-0.132]],
  },
  { type: 'rest', title: "Ordesa y Monte Perdido (base day)", at: "Torla-Ordesa, Spain" },
  {
    type: 'drive',
    start: "Torla-Ordesa, Spain",
    end: "Aigüestortes i Estany de Sant Maurici National Park",
    distanceKm: 148.3,
    driveMinutes: 168,
    fuel: [{ alongKm: 16, lat: 42.60675, lng: -0.12333 }],
    route: [[42.696,-0.132],[42.631,-0.112],[42.542,-0.133],[42.475,-0.05],[42.446,0.063],[42.391,0.181],[42.431,0.305],[42.405,0.403],[42.365,0.524],[42.405,0.601],[42.434,0.699],[42.462,0.769],[42.543,0.839]],
  },
  { type: 'rest', title: "Aigüestortes i Estany de Sant Maurici (base day)", at: "Aigüestortes i Estany de Sant Maurici National Park" },
  {
    type: 'drive',
    start: "Aigüestortes i Estany de Sant Maurici National Park",
    end: "Madrid, Spain",
    distanceKm: 554.8,
    driveMinutes: 359,
    fuel: [{ alongKm: 393, lat: 41.16889, lng: -2.42153 }],
    route: [[42.543,0.839],[42.456,0.76],[42.359,0.741],[42.261,0.735],[42.16,0.693],[42.119,0.595],[42.109,0.461],[42.124,0.319],[42.066,0.217],[42.032,0.083],[42.063,-0.051],[42.106,-0.179],[42.133,-0.312],[42.146,-0.429],[42.067,-0.52],[42.006,-0.639],[41.933,-0.742],[41.843,-0.806],[41.739,-0.846],[41.671,-0.933],[41.617,-1.052],[41.544,-1.149],[41.523,-1.274],[41.481,-1.405],[41.422,-1.494],[41.36,-1.601],[41.311,-1.726],[41.322,-1.866],[41.312,-2.003],[41.303,-2.143],[41.232,-2.245],[41.202,-2.373],[41.123,-2.444],[41.034,-2.479],[40.987,-2.606],[40.927,-2.719],[40.862,-2.833],[40.803,-2.951],[40.728,-3.052],[40.643,-3.138],[40.582,-3.235],[40.506,-3.335],[40.467,-3.459],[40.45,-3.596],[40.392,-3.679],[40.417,-3.705]],
  },
  {
    type: 'drive',
    start: "Madrid, Spain",
    end: "Isla Mayor, Spain",
    distanceKm: 563.9,
    driveMinutes: 332,
    fuel: [{ alongKm: 342, lat: 38.92202, lng: -6.37561 }],
    route: [[40.417,-3.705],[40.364,-3.811],[40.304,-3.921],[40.26,-4.045],[40.182,-4.137],[40.127,-4.249],[40.074,-4.361],[40.023,-4.48],[40.008,-4.619],[39.985,-4.754],[39.981,-4.853],[39.937,-4.978],[39.925,-5.113],[39.905,-5.24],[39.893,-5.38],[39.887,-5.52],[39.84,-5.644],[39.769,-5.736],[39.685,-5.722],[39.623,-5.827],[39.517,-5.838],[39.417,-5.885],[39.315,-5.856],[39.214,-5.88],[39.129,-5.953],[39.058,-6.056],[38.983,-6.14],[38.951,-6.256],[38.917,-6.375],[38.813,-6.376],[38.71,-6.395],[38.607,-6.368],[38.502,-6.354],[38.399,-6.342],[38.296,-6.302],[38.191,-6.282],[38.086,-6.261],[37.987,-6.234],[37.883,-6.219],[37.785,-6.183],[37.685,-6.183],[37.592,-6.122],[37.497,-6.071],[37.399,-6.027],[37.299,-6.051],[37.233,-6.142],[37.148,-6.153],[37.133,-6.166]],
  },
  { type: 'rest', title: "Doñana (base day)", at: "Isla Mayor, Spain" },
  {
    type: 'drive',
    start: "Isla Mayor, Spain",
    end: "Sierra Nevada",
    distanceKm: 328.1,
    driveMinutes: 226,
    fuel: [{ alongKm: 319, lat: 37.13482, lng: -3.4421, reason: { kind: 'next_day_fuel_far', gap_km: 17 } }],
    route: [[37.133,-6.166],[37.218,-6.135],[37.282,-6.062],[37.371,-6.02],[37.386,-5.938],[37.341,-5.821],[37.295,-5.709],[37.255,-5.585],[37.277,-5.459],[37.228,-5.342],[37.233,-5.213],[37.235,-5.082],[37.267,-4.956],[37.281,-4.849],[37.209,-4.794],[37.136,-4.709],[37.072,-4.602],[37.084,-4.472],[37.13,-4.358],[37.147,-4.232],[37.162,-4.107],[37.193,-3.988],[37.195,-3.861],[37.19,-3.729],[37.175,-3.613],[37.156,-3.526],[37.132,-3.438],[37.095,-3.401]],
  },
  { type: 'rest', title: "Sierra Nevada (base day)", at: "Sierra Nevada" },
  {
    type: 'drive',
    start: "Sierra Nevada",
    end: "Madrid",
    distanceKm: 453.8,
    driveMinutes: 279,
    fuel: [],
    route: [[37.095,-3.401],[37.141,-3.481],[37.156,-3.58],[37.215,-3.625],[37.312,-3.649],[37.399,-3.572],[37.49,-3.588],[37.565,-3.62],[37.666,-3.615],[37.745,-3.687],[37.823,-3.764],[37.926,-3.784],[38.029,-3.776],[38.123,-3.756],[38.2,-3.668],[38.283,-3.592],[38.368,-3.518],[38.472,-3.503],[38.576,-3.483],[38.668,-3.451],[38.766,-3.408],[38.871,-3.392],[38.978,-3.383],[39.081,-3.376],[39.187,-3.4],[39.282,-3.452],[39.383,-3.498],[39.486,-3.524],[39.592,-3.521],[39.697,-3.498],[39.802,-3.479],[39.907,-3.476],[39.979,-3.569],[40.051,-3.656],[40.149,-3.659],[40.253,-3.69],[40.355,-3.679],[40.417,-3.705]],
  },
];

/** The third screen's pasted place, added to day 4 (index 3). */
export const INTRO_ADDED_STOP = {
  dayIndex: 3,
  name: 'Castro Urdiales',
  alongKm: 161,
  lat: 43.36882,
  lng: -3.21564,
} as const;

/** The second screen's day: Madrid → Isla Mayor, day 10. */
export const INTRO_FUEL_DAY_INDEX = 9;

export function introDriveLeg(index: number): IntroDriveLeg {
  const leg = INTRO_LEGS[index];
  if (!leg || leg.type !== 'drive') throw new Error(`intro leg ${index} is not a drive day`);
  return leg;
}

/** "YYYY-MM-DD" in local time. */
function localISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The trip's start date: two weeks from `now`. The only invented value on
 * these screens, and deliberately so — a fixed date would be in the past the
 * month after release, and the card shows dates.
 */
export function introStartISO(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14);
  return localISO(d);
}

/** The date of leg `index`, one leg per calendar day (planSummary.ts's model). */
export function introLegDateISO(startISO: string, index: number): string {
  return legDateISO(startISO, index);
}

/**
 * The plan summary card's facts, built the way `computePlanSummary`
 * (src/lib/penny/planSummary.ts) builds them from persisted legs —
 * introFixture.test.ts asserts the two agree field for field.
 */
export function introPlanSummary(startISO: string): PlanSummary {
  const drives = INTRO_LEGS.filter((l): l is IntroDriveLeg => l.type === 'drive');
  const first = drives[0];
  const last = drives[drives.length - 1];
  let lastDriveIndex = 0;
  INTRO_LEGS.forEach((l, i) => {
    if (l.type === 'drive') lastDriveIndex = i;
  });
  const nights: Array<{ name: string | null; nights: number }> = [];
  INTRO_LEGS.forEach((l, i) => {
    if (l.type !== 'drive') return;
    let n = 0;
    for (let j = i + 1; j < INTRO_LEGS.length && INTRO_LEGS[j].type === 'rest'; j++) n++;
    if (n > 0) nights.push({ name: l.end, nights: n });
  });
  return {
    total_days: INTRO_LEGS.length,
    drive_days: drives.length,
    rest_days: INTRO_LEGS.length - drives.length,
    depart_date_iso: startISO,
    depart_name: first.start,
    arrive_date_iso: introLegDateISO(startISO, lastDriveIndex),
    arrive_name: last.end,
    depart_time: DEFAULT_DAY_MODEL_CONFIG.typicalDepartureTime,
    arrive_time: computeArrivalTime(last.driveMinutes).arrivalTime,
    total_distance_km: drives.reduce((s, l) => s + l.distanceKm, 0),
    total_drive_minutes: drives.reduce((s, l) => s + l.driveMinutes, 0),
    nights_per_stop: nights,
  };
}
