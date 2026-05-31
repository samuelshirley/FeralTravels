/**
 * Trip data contract tests.
 *
 * These tests verify that the types flowing from the DB to the UI contain all
 * fields the UI needs — so we never silently regress by adding a new feature
 * that forgets to persist or expose data.
 *
 * The philosophy: the UI should render from a single getTripFull() call with
 * ZERO external API calls. If a new field is needed by the UI, it must be
 * present on the types returned from the DB, and these tests should be
 * extended to cover it.
 */
import { describe, expect, it } from 'vitest';
import type { Leg, LegWithDetails, Stop, TripWithLegs } from '@/types/trip';

// ---------------------------------------------------------------------------
// Fixtures — minimal valid data
// ---------------------------------------------------------------------------

function makeLeg(overrides: Partial<Leg> = {}): Leg {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    trip_id: '00000000-0000-0000-0000-000000000001',
    sort_order: 0,
    leg_type: 'drive',
    title: 'Day 1: Girona → Lyon',
    label: null,
    segment_index: null,
    segment_name: null,
    start_name: 'Girona',
    end_name: 'Lyon',
    start_lat: 41.9794,
    start_lng: 2.8214,
    end_lat: 45.764,
    end_lng: 4.8357,
    dates: null,
    date_iso: '2024-06-01',
    distance_km: 487.3,
    drive_time_minutes: 285,
    terrain: 'highway',
    overnight: 'Lyon',
    status: 'planning',
    color: '#4E7AB0',
    notes: null,
    fuel_status: 'none',
    fuel_plan_error: null,
    geometry: {
      type: 'LineString',
      coordinates: [
        [2.8214, 41.9794],
        [3.0, 42.5],
        [4.8357, 45.764],
      ],
    },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeStop(overrides: Partial<Stop> = {}): Stop {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    leg_id: '00000000-0000-0000-0000-000000000001',
    sort_order: 0,
    stop_type: 'fuel',
    status: 'option',
    name: 'Repsol Perpignan',
    lat: 42.6887,
    lng: 2.8948,
    distance_from_start_km: 62,
    notes: null,
    fuel_type: 'diesel',
    fuel_amount_l: null,
    source: 'google_places',
    source_url: null,
    alternatives: null,
    place_id: 'ChIJ_test_place_id',
    google_maps_uri: 'https://www.google.com/maps/place/?q=place_id:ChIJ_test_place_id',
    photos: [
      {
        url: 'https://places.googleapis.com/v1/places/ChIJ_test/photos/abc/media?maxWidthPx=400',
        attribution: 'Google',
        width_px: 400,
        height_px: 300,
      },
    ],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeLegWithDetails(overrides: Partial<LegWithDetails> = {}): LegWithDetails {
  return {
    ...makeLeg(),
    costs: [],
    links: [],
    routes: [],
    stops: [makeStop()],
    tasks: [],
    constraints: [],
    parsedNotes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Trip data contract — fields required by the UI', () => {
  describe('Leg', () => {
    it('has geometry for map polyline rendering', () => {
      const leg = makeLeg();
      expect(leg).toHaveProperty('geometry');
      expect(leg.geometry).not.toBeNull();
      expect(leg.geometry?.type).toBe('LineString');
      expect(leg.geometry?.coordinates).toBeInstanceOf(Array);
      expect(leg.geometry!.coordinates.length).toBeGreaterThan(0);
      // GeoJSON uses [lng, lat] order
      const [lng, lat] = leg.geometry!.coordinates[0];
      expect(lng).toBeTypeOf('number');
      expect(lat).toBeTypeOf('number');
    });

    it('geometry coordinates use [lng, lat] GeoJSON order', () => {
      const leg = makeLeg();
      // start_lng=2.8214, start_lat=41.9794
      const [firstLng, firstLat] = leg.geometry!.coordinates[0];
      expect(firstLng).toBeCloseTo(2.8214, 3);
      expect(firstLat).toBeCloseTo(41.9794, 3);
    });

    it('allows null geometry for legs without directions', () => {
      const leg = makeLeg({ geometry: null });
      expect(leg.geometry).toBeNull();
    });
  });

  describe('Stop', () => {
    it('has photos array for rendering without API calls', () => {
      const stop = makeStop();
      expect(stop).toHaveProperty('photos');
      expect(stop.photos).toBeInstanceOf(Array);
      expect(stop.photos!.length).toBeGreaterThan(0);
      expect(stop.photos![0]).toHaveProperty('url');
      expect(stop.photos![0]).toHaveProperty('attribution');
      expect(stop.photos![0]).toHaveProperty('width_px');
      expect(stop.photos![0]).toHaveProperty('height_px');
    });

    it('has place_id for direct Google links', () => {
      const stop = makeStop();
      expect(stop).toHaveProperty('place_id');
      expect(typeof stop.place_id).toBe('string');
    });

    it('has google_maps_uri for direct navigation', () => {
      const stop = makeStop();
      expect(stop).toHaveProperty('google_maps_uri');
      expect(stop.google_maps_uri).toContain('google.com/maps');
    });

    it('allows null for all new fields (user-created stops)', () => {
      const stop = makeStop({
        place_id: null,
        google_maps_uri: null,
        photos: null,
      });
      expect(stop.place_id).toBeNull();
      expect(stop.google_maps_uri).toBeNull();
      expect(stop.photos).toBeNull();
    });
  });

  describe('LegWithDetails', () => {
    it('includes stops with photos in the nested structure', () => {
      const leg = makeLegWithDetails();
      expect(leg.stops.length).toBeGreaterThan(0);
      expect(leg.stops[0].photos).toBeInstanceOf(Array);
    });

    it('includes geometry in the nested structure', () => {
      const leg = makeLegWithDetails();
      expect(leg.geometry).not.toBeNull();
      expect(leg.geometry?.type).toBe('LineString');
    });
  });

  describe('TripWithLegs completeness', () => {
    it('all UI-required fields are present on a complete trip', () => {
      const trip: TripWithLegs = {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Test Road Trip',
        start_date: '2024-06-01',
        end_date: '2024-06-15',
        start_date_parsed: '2024-06-01',
        end_date_parsed: '2024-06-15',
        status: 'active',
        trip_status: 'draft',
        onboarding_state: 'done',
        prefer_avoid_highways: false,
        last_known_lat: null,
        last_known_lng: null,
        position_updated_at: null,
        current_leg_id: null,
        current_lat: null,
        current_lng: null,
        progress_anchor_date: null,
        progress_updated_at: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        user_id: '00000000-0000-0000-0000-000000000099',
        vehicle_id: '00000000-0000-0000-0000-000000000050',
        is_template: false,
        legs: [makeLegWithDetails()],
      };

      // Core trip fields
      expect(trip.legs.length).toBeGreaterThan(0);

      // Each leg must have geometry for the map
      for (const leg of trip.legs) {
        expect(leg).toHaveProperty('geometry');
      }

      // Each stop must have photo/place fields (can be null, but must exist)
      for (const leg of trip.legs) {
        for (const stop of leg.stops) {
          expect(stop).toHaveProperty('photos');
          expect(stop).toHaveProperty('place_id');
          expect(stop).toHaveProperty('google_maps_uri');
        }
      }
    });
  });
});
