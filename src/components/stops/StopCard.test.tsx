import { afterEach, describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StopCard from './StopCard';
import { UnitsProvider } from '@/components/UnitsContext';
import type { StopCardProps } from './StopCard';

afterEach(cleanup);

const DRIVE_URL =
  'https://www.google.com/maps/dir/?api=1&destination=42.3441%2C-3.6969&travelmode=driving&dir_action=navigate&destination_place_id=ChIJ_burgos';

const baseProps: StopCardProps = {
  stopType: 'fuel',
  name: 'Fuel stop',
  distanceFromStartKm: 62,
  googleMapsUri: DRIVE_URL,
};

/** A place the user added keeps its own name and a separate distance line. */
const otherProps: StopCardProps = {
  stopType: 'other',
  name: 'Burgos Cathedral',
  distanceFromStartKm: 62,
  googleMapsUri: DRIVE_URL,
};

describe('StopCard', () => {
  it('renders stop type label', () => {
    render(<StopCard {...baseProps} />);
    expect(screen.getByText('FUEL')).toBeInTheDocument();
  });

  it('labels a fuel stop "Fuel stop · <distance>", with no separate distance line', () => {
    render(
      <UnitsProvider initialUnits="metric">
        <StopCard {...baseProps} />
      </UnitsProvider>
    );
    expect(screen.getByText('Fuel stop · 62 km')).toBeInTheDocument();
    expect(screen.queryByText(/from start/)).not.toBeInTheDocument();
  });

  it('labels a fuel stop in miles, and no km, for an imperial user', () => {
    render(
      <UnitsProvider initialUnits="imperial">
        <StopCard {...baseProps} />
      </UnitsProvider>
    );
    expect(screen.getByText('Fuel stop · 39 mi')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bkm\b/);
  });

  it("never shows a Google station name a legacy fuel row still carries", () => {
    render(<StopCard {...baseProps} name="Repsol Burgos Norte" />);
    expect(screen.queryByText(/Repsol/)).not.toBeInTheDocument();
    expect(screen.getByText('Fuel stop · 62 km')).toBeInTheDocument();
  });

  it("renders a user-added stop's own name", () => {
    render(<StopCard {...otherProps} />);
    expect(screen.getByText('Burgos Cathedral')).toBeInTheDocument();
  });

  /**
   * The caption is now assembled from the shared `Distance` component plus the
   * literal " from start", so it spans two elements and a plain string match no
   * longer finds it. Matching on the container's textContent is the point of
   * the change, not a workaround for it: what used to be one hardcoded
   * `${km} km` is now a units-aware render, and these two tests are what say so.
   */
  it('renders distance from start in km for a metric user', () => {
    render(
      <UnitsProvider initialUnits="metric">
        <StopCard {...otherProps} />
      </UnitsProvider>
    );
    expect(screen.getByText(/from start/).textContent).toBe('62 km from start');
  });

  /**
   * The regression. This caption and the map's marker tooltip were the only two
   * distances in the app that ignored `units_pref` outright — an imperial user
   * got kilometres here and nowhere else, with no miles at all, while every
   * neighbouring distance went through `Distance`.
   *
   * Note what "imperial" means here and why the assertion looks like this: the
   * app deliberately keeps km as the PRIMARY label for everyone and adds miles
   * as a secondary (see the header of src/lib/units.ts — "we've decided to
   * teach metric"). So the fix is that miles APPEAR, not that km disappears. If
   * that product decision is ever reversed, this test is one of the places that
   * has to change, on purpose.
   */
  it('shows miles, and no kilometres, for an imperial user', () => {
    // The "km primary, (mi) secondary" decision this test used to pin was
    // reversed on 2026-09-04: an imperial user sees miles and nothing else.
    render(
      <UnitsProvider initialUnits="imperial">
        <StopCard {...otherProps} />
      </UnitsProvider>
    );
    const text = screen.getByText(/from start/).textContent ?? '';
    expect(text).toContain('39 mi'); // 62 km × 0.621371 = 38.5 → 39
    expect(text).not.toMatch(/\bkm\b/);
    expect(text).toMatch(/from start$/);
  });

  it('renders nothing unit-shaped when there is no distance', () => {
    render(
      <UnitsProvider initialUnits="imperial">
        <StopCard {...otherProps} distanceFromStartKm={null} />
      </UnitsProvider>
    );
    expect(screen.queryByText(/from start/)).not.toBeInTheDocument();
  });

  it('opens Google Maps in new tab when clicked', () => {
    render(<StopCard {...baseProps} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', DRIVE_URL);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders the user-added (other) stop type', () => {
    render(<StopCard {...baseProps} stopType="other" />);
    expect(screen.getByText('STOP')).toBeInTheDocument();
  });

  it('handles null distance', () => {
    render(<StopCard {...baseProps} distanceFromStartKm={null} />);
    expect(screen.getByText('Fuel stop')).toBeInTheDocument();
    expect(screen.queryByText(/km from start/)).not.toBeInTheDocument();
  });

  it('falls back to coordinate-based Maps URL when no googleMapsUri', () => {
    render(
      <StopCard
        {...baseProps}
        googleMapsUri={null}
        lat={42.3441}
        lng={-3.6969}
      />
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toContain('42.3441');
    expect(link.getAttribute('href')).toContain('-3.6969');
  });

  describe("Finn's forced-stop reason", () => {
    const forcedReason = { kind: 'next_fuel_far', gap_km: 412 } as const;

    it('shows the line on a forced fuel stop, in km for a metric user', () => {
      render(
        <UnitsProvider initialUnits="metric">
          <StopCard {...baseProps} forcedReason={forcedReason} />
        </UnitsProvider>
      );
      expect(screen.getByText('Top up here: next fuel is 412 km away')).toBeInTheDocument();
    });

    it('shows miles, and no kilometres, for an imperial user', () => {
      render(
        <UnitsProvider initialUnits="imperial">
          <StopCard {...baseProps} forcedReason={forcedReason} />
        </UnitsProvider>
      );
      const line = screen.getByText(/^Top up here/).textContent ?? '';
      expect(line).toBe('Top up here: next fuel is 256 mi away');
      expect(line).not.toMatch(/\bkm\b/);
    });

    it('is absent on a fuel stop Finn did not force', () => {
      render(<StopCard {...baseProps} forcedReason={null} />);
      expect(screen.queryByText(/Top up here/)).not.toBeInTheDocument();
    });

    it('is absent on a user-added stop even if a reason is passed', () => {
      render(<StopCard {...baseProps} stopType="other" forcedReason={forcedReason} />);
      expect(screen.queryByText(/Top up here/)).not.toBeInTheDocument();
    });
  });
});
