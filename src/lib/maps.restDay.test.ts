/**
 * A rest day has nowhere to drive to, so it must not be offered anywhere to
 * drive to.
 *
 * The bug (reported 2026-08-27, desktop web): a day titled "Porto (rest day)",
 * with no distance and no duration, sitting after "Salamanca → Porto", rendered
 * "NAVIGATE (1 STOP)" and a primary button "▶ Route to Destination — Porto".
 * Pressing it did nothing useful, because the driver was already in Porto.
 *
 * What the button actually contained is worth writing down, because it is not
 * the obvious thing. It was NOT a place-to-itself directions URL. Segment URLs
 * deliberately carry no `origin` so Google Maps starts from device GPS:
 *
 *   https://www.google.com/maps/dir/?api=1&destination=41.1579%2C-8.6291
 *     &travelmode=driving&dir_action=navigate
 *
 * A perfectly well-formed navigation request — to the spot the driver is
 * standing on. Maps launches turn-by-turn and immediately arrives. Nothing
 * about the URL is malformed, which is why no URL-shaped test ever caught it.
 *
 * (`buildLegDirectionsUrl`, the separate fallback link used only while fuel is
 * syncing, DOES emit origin === destination for such a leg. That one is a
 * literal no-op. It is out of frame here: it renders for a few seconds during a
 * replan, not as the day's primary button.)
 */
import { describe, expect, it } from 'vitest';
import { buildSegmentedNavUrls, isStationaryLeg, type LegDirectionsStopInput } from './maps';

const PORTO = { lat: 41.1579, lng: -8.6291 };
/** Livraria Lello — the kind of place a user adds to a rest day. */
const LELLO = { lat: 41.1465, lng: -8.6149 };
const SALAMANCA = { lat: 40.9701, lng: -5.6635 };

/** The reported leg: start and end are the same place, nothing driven. */
const REST_DAY = {
  legCoords: {
    start_lat: PORTO.lat,
    start_lng: PORTO.lng,
    end_lat: PORTO.lat,
    end_lng: PORTO.lng,
  },
  endName: 'Porto',
  distanceKm: null,
  driveTimeMinutes: null,
};

function addedStop(): LegDirectionsStopInput {
  return {
    lat: LELLO.lat,
    lng: LELLO.lng,
    status: 'selected',
    stop_type: 'other',
    name: 'Livraria Lello',
    source: 'penny',
    distance_from_start_km: 2,
    sort_order: 0,
  };
}

describe('buildSegmentedNavUrls — a day spent in one place', () => {
  it('offers nothing at all on a rest day with no added stops', () => {
    // Null, not an empty array: both LegCards gate the whole nav block on
    // `allSegments.length > 0`, so this is what removes the section entirely
    // rather than leaving an empty "NAVIGATE (0 STOPS)" heading behind.
    expect(buildSegmentedNavUrls({ ...REST_DAY, stops: [] })).toBeNull();
  });

  it('still offers an added stop on a rest day, and only that', () => {
    // The half of "NAVIGATE (1 STOP)" that was doing real work. Driving to a
    // bookshop on your day off is a drive; driving to Porto from Porto is not.
    const segments = buildSegmentedNavUrls({ ...REST_DAY, stops: [addedStop()] })!;

    expect(segments).toHaveLength(1);
    expect(segments[0].label).toBe('Livraria Lello');
    expect(segments[0].stopType).toBe('other');
    expect(segments.some((s) => s.stopType === 'destination')).toBe(false);

    const u = new URL(segments[0].url);
    expect(u.searchParams.get('destination')).toBe(`${LELLO.lat},${LELLO.lng}`);
  });

  it('keeps the destination on a day-loop that returns to its own start', () => {
    // Out into the Douro valley and back to Porto: same coords, real driving.
    // This driver does want a button home, which is why the coordinate check
    // alone would have been the wrong fix.
    const segments = buildSegmentedNavUrls({
      ...REST_DAY,
      distanceKm: 240,
      driveTimeMinutes: 300,
      stops: [addedStop()],
    })!;

    expect(segments.map((s) => s.stopType)).toEqual(['other', 'destination']);
    expect(segments[1].label).toBe('Porto');
  });

  it('keeps the destination when the leg has no start coords to compare', () => {
    // We cannot tell whether the driver is already there. A redundant button
    // beats a missing one — that is the lesson of the GPS single-button bug.
    const segments = buildSegmentedNavUrls({
      legCoords: { start_lat: null, start_lng: null, end_lat: PORTO.lat, end_lng: PORTO.lng },
      endName: 'Porto',
      stops: [],
    })!;

    expect(segments).toHaveLength(1);
    expect(segments[0].stopType).toBe('destination');
  });

  it('leaves an ordinary driving day untouched', () => {
    const segments = buildSegmentedNavUrls({
      legCoords: {
        start_lat: SALAMANCA.lat,
        start_lng: SALAMANCA.lng,
        end_lat: PORTO.lat,
        end_lng: PORTO.lng,
      },
      endName: 'Porto',
      distanceKm: 330,
      driveTimeMinutes: 220,
      stops: [],
    })!;

    expect(segments).toHaveLength(1);
    expect(segments[0].stopType).toBe('destination');
    expect(segments[0].label).toBe('Porto');
  });
});

describe('isStationaryLeg', () => {
  const coords = REST_DAY.legCoords;

  it('treats a same-place leg with no driving as stationary', () => {
    expect(isStationaryLeg({ legCoords: coords, destination: PORTO })).toBe(true);
  });

  it('tolerates the sub-kilometre coordinate drift of two Porto pins', () => {
    // Penny resolves the rest day and the arriving drive independently, so the
    // two "Porto"s are rarely the identical float pair.
    expect(
      isStationaryLeg({ legCoords: coords, destination: { lat: 41.1585, lng: -8.6302 } })
    ).toBe(true);
  });

  it('is not fooled by a genuinely short drive to a nearby town', () => {
    expect(
      isStationaryLeg({
        legCoords: coords,
        destination: { lat: 41.2279, lng: -8.6845 }, // Matosinhos, ~9 km
      })
    ).toBe(false);
  });

  it('is not stationary once the leg carries distance or drive time', () => {
    expect(
      isStationaryLeg({ legCoords: coords, destination: PORTO, distanceKm: 240 })
    ).toBe(false);
    expect(
      isStationaryLeg({ legCoords: coords, destination: PORTO, driveTimeMinutes: 300 })
    ).toBe(false);
  });
});
