/**
 * App screenshots of the two-week Spain national-parks trip, in display order:
 * the request, a planned day with Finn's fuel stop, the map. Three, because
 * the section's grid is three across on desktop and three wide when swiped.
 *
 * Unedited iPhone 17 Pro Max simulator captures (en_GB) of a real plan Penny
 * built from one message, with Finn's fuel stops, taken on a local build and
 * a local database. The section renders only when this has entries, so an
 * empty list ships no placeholder frames.
 */
export type LandingScreenshot = {
  /** Path under public/, e.g. '/landing/shot-plan.png'. */
  src: string;
  alt: string;
  width: number;
  height: number;
};

export const LANDING_SCREENSHOTS: LandingScreenshot[] = [
  {
    src: '/landing/spain-01-penny-request.png',
    alt: 'Chat with Penny: two weeks around six national parks, a loop from Madrid, with the start date and driving pace',
    width: 1320,
    height: 2868,
  },
  {
    src: '/landing/spain-02-itinerary.png',
    alt: "Day 2, Monzón de Campos to Cabrales: Finn adds a fuel stop because the next station is too far into the following day's drive",
    width: 1320,
    height: 2868,
  },
  {
    src: '/landing/spain-03-map.png',
    alt: "Map of the loop around Spain's national parks, with overnight stops and six fuel stops",
    width: 1320,
    height: 2868,
  },
];
