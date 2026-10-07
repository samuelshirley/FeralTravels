import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import TripCard from './TripCard';
import { UnitsProvider } from '@/components/UnitsContext';

afterEach(cleanup);

/**
 * The trips list's one-line footnote for the trip's next fuel stop. The server
 * sends the stored row name; a fuel row's name is never shown (a row saved
 * before migration 0046 still carries a Google station name), only
 * "Fuel stop · <distance>" in the user's units.
 */
describe('TripCard next fuel stop', () => {
  function renderCard(units: 'metric' | 'imperial', distance_km: number | null) {
    return render(
      <UnitsProvider initialUnits={units}>
        <TripCard
          id="00000000-0000-0000-0000-000000000001"
          name="Iberian loop"
          nextStop={{ name: 'Repsol Burgos Norte', distance_km }}
        />
      </UnitsProvider>
    );
  }

  it('reads "Next: Fuel stop · 212 km" for a metric user', () => {
    renderCard('metric', 212);
    expect(screen.getByText('Next: Fuel stop · 212 km')).toBeInTheDocument();
    expect(screen.queryByText(/Repsol/)).not.toBeInTheDocument();
  });

  it('reads miles, and no km, for an imperial user', () => {
    const { container } = renderCard('imperial', 212);
    expect(screen.getByText('Next: Fuel stop · 132 mi')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bkm\b/);
  });

  it('is just "Next: Fuel stop" with no distance', () => {
    renderCard('metric', null);
    expect(screen.getByText('Next: Fuel stop')).toBeInTheDocument();
  });
});
