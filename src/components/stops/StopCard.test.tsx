import { afterEach, describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StopCard from './StopCard';
import { UnitsProvider } from '@/components/UnitsContext';
import type { StopCardProps } from './StopCard';

afterEach(cleanup);

const baseProps: StopCardProps = {
  stopType: 'fuel',
  name: 'Repsol Burgos Norte',
  distanceFromStartKm: 62,
  googleMapsUri: 'https://www.google.com/maps/place/Repsol+Burgos',
};

describe('StopCard', () => {
  it('renders stop type label', () => {
    render(<StopCard {...baseProps} />);
    expect(screen.getByText('FUEL')).toBeInTheDocument();
  });

  it('renders stop name', () => {
    render(<StopCard {...baseProps} />);
    expect(screen.getByText('Repsol Burgos Norte')).toBeInTheDocument();
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
        <StopCard {...baseProps} />
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
  it('adds the miles equivalent for an imperial user', () => {
    render(
      <UnitsProvider initialUnits="imperial">
        <StopCard {...baseProps} />
      </UnitsProvider>
    );
    const text = screen.getByText(/from start/).textContent ?? '';
    expect(text).toContain('62 km');
    expect(text).toContain('39 mi'); // 62 km × 0.621371 = 38.5 → 39
    expect(text).toMatch(/from start$/);
  });

  it('renders nothing unit-shaped when there is no distance', () => {
    render(
      <UnitsProvider initialUnits="imperial">
        <StopCard {...baseProps} distanceFromStartKm={null} />
      </UnitsProvider>
    );
    expect(screen.queryByText(/from start/)).not.toBeInTheDocument();
  });

  it('opens Google Maps in new tab when clicked', () => {
    render(<StopCard {...baseProps} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://www.google.com/maps/place/Repsol+Burgos');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders the user-added (other) stop type', () => {
    render(<StopCard {...baseProps} stopType="other" />);
    expect(screen.getByText('STOP')).toBeInTheDocument();
  });

  it('handles null distance', () => {
    render(<StopCard {...baseProps} distanceFromStartKm={null} />);
    expect(screen.getByText('Repsol Burgos Norte')).toBeInTheDocument();
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
});
