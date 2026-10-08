/**
 * Facts Penny has no source for, refused in code.
 *
 * THE INCIDENT (trip 9a3df982, 2026-10-08). The driver asked for off-road and
 * gravel routes and then said "yea lets do them all". Penny saved four
 * "gravel/off-road" waypoints, and three were invented: Col du Tourmalet, a
 * fully PAVED pass, noted "mixed surface"; Gradas de Soaso, a HIKING trail in
 * Ordesa where cars are restricted; and Circuito Costa de Almería, a paved
 * RACING CIRCUIT, noted "Gravel loop through the desert". None of our tools
 * returns a road surface. The prompt's no-guess rule gave way the moment the
 * driver pushed, so this is the part that does not.
 *
 * Two checks, both pure:
 *
 *  1. `findSurfaceClaim` — free text Penny writes into the plan (a stop's
 *     notes, a leg's notes, a route's description) may not describe a road
 *     surface. The tool validators reject it with a message she can act on.
 *  2. `notDrivableReason` — a place Google itself types as a race course, a
 *     karting venue or a hiking area is not a drivable waypoint. resolve_place
 *     flags it, and the replan loop refuses an add_stop placed on it.
 */

/**
 * Words that assert what a road is made of, or how rough it is. Any of these in
 * text Penny authored is a claim no tool gave her. "paved" is in the list too:
 * "fully paved" is exactly as unsourced as "gravel".
 */
const SURFACE_CLAIM_RE =
  /\b(gravel|unpaved|unsealed|paved|asphalt|tarmac|dirt|off[\s-]?road(?:ing)?|4x4|4wd|washboard|corrugat\w*|mixed[\s-]surface|road surface|surface|jeep (?:track|trail|road)|forest (?:track|road)|fire road|pista|piste|sterrato|chemin de terre|rough (?:terrain|road|roads|track|tracks)|(?:wash|river|water) crossings?|high[\s-]clearance)\b/i;

/** The first surface claim in `text`, as written, or null. */
export function findSurfaceClaim(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = SURFACE_CLAIM_RE.exec(text);
  return m ? m[0] : null;
}

/** The validator message for a surface claim — instructive, so she self-corrects in-loop. */
export function surfaceClaimMessage(field: string, phrase: string): string {
  return (
    `${field} says "${phrase}" — that describes a road surface, and none of your tools ` +
    `returns road surface or condition. Remove the claim (write what the place IS, from ` +
    `resolve_place, or nothing). Never label a place or road gravel, unpaved, off-road, ` +
    `paved or "mixed surface".`
  );
}

/** The message for a field Penny may not author at all (leg terrain, route surface). */
export function unsourcedFieldMessage(field: string): string {
  return (
    `Do not set ${field}. No tool tells you a road's surface or terrain, so any value ` +
    `here would be invented. Omit the field.`
  );
}

/**
 * Google Places (New) types that mark a place as somewhere you do not drive
 * THROUGH. Exact strings from Table A of the Places API (New) place-types page,
 * checked 2026-10-08 (`race_course` and `go_karting_venue` were added in the
 * 2026-02-12 release). `types` and `primaryType` are both Text Search Pro
 * fields — the SKU resolve_place already bills — so reading them adds no SKU.
 *
 * `off_roading_area` is deliberately NOT here and NOT treated as a surface
 * source either: it is a venue type, not a statement about any road.
 */
export const NOT_DRIVABLE_PLACE_TYPES: Readonly<Record<string, string>> = {
  race_course: 'a race course',
  go_karting_venue: 'a go-karting venue',
  hiking_area: 'a hiking area',
};

/**
 * A racing circuit's own name, for the many circuits Google has not (yet)
 * typed `race_course` — the type is eight months old. Narrow on purpose:
 * words that only ever name a motor-racing venue.
 */
const RACE_CIRCUIT_NAME_RE =
  /\b(circuito|circuit de|circuit of|autodromo|autódromo|autodrome|motodromo|raceway|speedway|racetrack|race track|motorsport park|kartodromo|kartódromo)\b/i;

/**
 * A park that lists `hiking_area` among its types is still somewhere you drive
 * to. These types outrank a secondary `hiking_area`.
 */
const DRIVABLE_DESTINATION_TYPES = new Set([
  'national_park', 'state_park', 'park', 'city_park', 'visitor_center', 'campground',
  'rv_park', 'parking', 'locality', 'tourist_attraction',
]);

export interface PlaceTypeFacts {
  /** Google's `primaryType`, when it sent one. */
  primaryType?: string | null;
  /** Google's `types`. */
  types?: readonly string[] | null;
  /** The place's label. */
  name: string;
}

/**
 * Why this place is not a drivable waypoint, or null when nothing says so.
 *
 *  1. Its PRIMARY type is a race course, karting venue or hiking area.
 *  2. `race_course` / `go_karting_venue` anywhere in its types — nothing that
 *     carries one is a road to drive through.
 *  3. `hiking_area` in its types when Google gave no primary type AND nothing
 *     marks it as a park, visitor centre or car park.
 *  4. Its name is a racing circuit's name — for circuits Google types as
 *     something generic.
 */
export function notDrivableReason(place: PlaceTypeFacts): string | null {
  const types = place.types ?? [];
  const primary = place.primaryType ?? null;
  if (primary && NOT_DRIVABLE_PLACE_TYPES[primary]) {
    return `Google lists it as ${NOT_DRIVABLE_PLACE_TYPES[primary]}`;
  }
  for (const t of ['race_course', 'go_karting_venue']) {
    if (types.includes(t)) return `Google lists it as ${NOT_DRIVABLE_PLACE_TYPES[t]}`;
  }
  if (
    !primary &&
    types.includes('hiking_area') &&
    !types.some((t) => DRIVABLE_DESTINATION_TYPES.has(t))
  ) {
    return `Google lists it as ${NOT_DRIVABLE_PLACE_TYPES.hiking_area}`;
  }
  if (RACE_CIRCUIT_NAME_RE.test(place.name)) return 'its name says it is a racing circuit';
  return null;
}

/** What resolve_place tells Penny alongside a flagged place. */
export function notDrivableNote(reason: string): string {
  return (
    `NOT a drivable waypoint — ${reason}. Do not add it as a stop or route through it. ` +
    `If the user named it, tell them what it is and ask for the car park or trailhead to drive to.`
  );
}

/** The in-loop rejection for an add_stop placed on a flagged place. */
export function notDrivableStopMessage(stopName: string, placeLabel: string, reason: string): string {
  return (
    `Stop "${stopName}" is at ${placeLabel}, which is not a drivable waypoint (${reason}). ` +
    `Do not add it. If the user asked for it by name, tell them plainly what it is and ` +
    `ask which car park or trailhead to drive to; otherwise leave it out and say so.`
  );
}
