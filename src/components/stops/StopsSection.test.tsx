import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Stop } from '@/types/trip';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/trips/00000000-0000-0000-0000-000000000001',
}));

// Mock the API module
vi.mock('@/lib/api', () => ({
  tripApi: () => ({
    listStopsForLeg: vi.fn().mockResolvedValue([]),
    addStop: vi.fn().mockResolvedValue({}),
    updateStop: vi.fn().mockResolvedValue({}),
    deleteStop: vi.fn().mockResolvedValue({}),
    selectStop: vi.fn().mockResolvedValue({}),
    swapStopPrimary: vi.fn().mockResolvedValue({}),
    parseCoords: vi.fn().mockResolvedValue(null),
  }),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  },
}));

// Mock coords
vi.mock('@/lib/coords', () => ({
  parseCoords: vi.fn().mockReturnValue(null),
  needsServerResolution: vi.fn().mockReturnValue(false),
}));

// Mock fuel error semantics
vi.mock('@/lib/fuelPlanErrorSemantics', () => ({
  classifyFuelPlanError: vi.fn().mockReturnValue('unknown'),
}));

// Must import StopsSection after mocks are set up
import StopsSection from '../StopsSection';

afterEach(cleanup);

const mockFuelStop: Stop = {
  id: '00000000-0000-0000-0000-000000000001',
  leg_id: '00000000-0000-0000-0000-000000000010',
  sort_order: 1,
  stop_type: 'fuel',
  status: 'selected',
  name: 'Repsol Burgos Norte',
  lat: 42.35,
  lng: -3.70,
  distance_from_start_km: 62,
  notes: null,
  fuel_type: 'diesel',
  fuel_amount_l: null,
  source: 'google_places',
  source_url: null,
  alternatives: null,
  place_id: null,
  google_maps_uri: null,
  price_state: null,
  price_per_litre: null,
  price_currency: null,
  price_fuel_type: null,
  price_country: null,
  price_source: null,
  price_as_of: null,
  created_at: '2024-01-01',
  updated_at: '2024-01-01',
};

const mockUserStop: Stop = {
  id: '00000000-0000-0000-0000-000000000002',
  leg_id: '00000000-0000-0000-0000-000000000010',
  sort_order: 2,
  stop_type: 'other',
  status: 'selected',
  name: 'Camping Ciudad de León',
  lat: 42.60,
  lng: -5.57,
  distance_from_start_km: 192,
  notes: null,
  fuel_type: null,
  fuel_amount_l: null,
  source: 'google_places',
  source_url: null,
  alternatives: null,
  place_id: null,
  google_maps_uri: null,
  price_state: null,
  price_per_litre: null,
  price_currency: null,
  price_fuel_type: null,
  price_country: null,
  price_source: null,
  price_as_of: null,
  created_at: '2024-01-01',
  updated_at: '2024-01-01',
};

const mockDismissedStop: Stop = {
  ...mockFuelStop,
  id: '00000000-0000-0000-0000-000000000003',
  name: 'Old BP Station',
  status: 'dismissed',
};

// Stub fetch so the component's lazy fuel-stop POST on mount is inert in tests.
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({}),
  }) as any;
});

describe('StopsSection (refactored)', () => {
  it('renders stop cards for active stops', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[mockFuelStop, mockUserStop]}
      />
    );
    expect(screen.getByText('Repsol Burgos Norte')).toBeInTheDocument();
    expect(screen.getByText('Camping Ciudad de León')).toBeInTheDocument();
  });

  it('shows fuel planning spinner', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[]}
        fuelStatus="computing"
      />
    );
    expect(screen.getByText('Planning fuel stops…')).toBeInTheDocument();
  });

  it('suppresses the fuel planning spinner on a past day', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[]}
        fuelStatus="computing"
        fuelLoading
        isPast
      />
    );
    expect(screen.queryByText('Planning fuel stops…')).not.toBeInTheDocument();
  });

  it('shows "no stops yet" when empty', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[]}
      />
    );
    expect(screen.getByText(/no stops yet/i)).toBeInTheDocument();
  });

  it('shows dismissed count in collapsed section', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[mockFuelStop, mockDismissedStop]}
      />
    );
    expect(screen.getByText('1 DISMISSED')).toBeInTheDocument();
  });

  it('shows a remove button for each active stop when not readonly', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[mockFuelStop]}
      />
    );
    expect(screen.getByLabelText(/remove repsol burgos norte/i)).toBeInTheDocument();
  });

  it('hides remove buttons when readonly', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[mockFuelStop]}
        readonly
      />
    );
    expect(screen.queryByLabelText(/remove repsol burgos norte/i)).not.toBeInTheDocument();
  });

  it('renders paste GPS section when not readonly', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[]}
      />
    );
    expect(screen.getByPlaceholderText(/paste gps/i)).toBeInTheDocument();
  });

  it('renders StopCard with correct type labels', () => {
    const userStop: Stop = {
      ...mockFuelStop,
      id: '00000000-0000-0000-0000-000000000004',
      stop_type: 'other',
      name: 'Fuente Carrionas',
      distance_from_start_km: 145,
    };
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[mockFuelStop, userStop]}
      />
    );
    expect(screen.getByText('FUEL')).toBeInTheDocument();
    expect(screen.getByText('STOP')).toBeInTheDocument();
  });

  it('stop cards link to Google Maps', () => {
    render(
      <StopsSection
        tripId="00000000-0000-0000-0000-000000000001"
        legId="00000000-0000-0000-0000-000000000010"
        legEndName="León"
        legEndCoords={{ lat: 42.6, lng: -5.57 }}
        initialStops={[mockFuelStop]}
      />
    );
    const links = screen.getAllByRole('link');
    const mapsLink = links.find((l) => l.getAttribute('href')?.includes('google.com/maps'));
    expect(mapsLink).toBeTruthy();
    expect(mapsLink).toHaveAttribute('target', '_blank');
  });
});
