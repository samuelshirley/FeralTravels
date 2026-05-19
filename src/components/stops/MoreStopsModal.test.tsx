import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MoreStopsModal from './MoreStopsModal';
import type { MoreStopsModalProps } from './MoreStopsModal';

afterEach(cleanup);

const mockStops = {
  fuel: [
    { name: 'Repsol Burgos Norte', lat: 42.35, lng: -3.70, distanceKm: 62, googleMapsUri: 'https://maps.google.com/fuel1', placeId: 'p1' },
    { name: 'Cepsa Osorno', lat: 42.40, lng: -4.35, distanceKm: 89, googleMapsUri: 'https://maps.google.com/fuel2', placeId: 'p2' },
    { name: 'BP Sahagún', lat: 42.37, lng: -5.03, distanceKm: 134, googleMapsUri: 'https://maps.google.com/fuel3', placeId: 'p3' },
  ],
  groceries: [
    { name: 'Aldi Palencia', lat: 42.01, lng: -4.53, distanceKm: 118, googleMapsUri: 'https://maps.google.com/groc1', placeId: 'p4' },
  ],
  water: [
    { name: 'Fuente Carrionas', lat: 42.50, lng: -4.77, distanceKm: 145, googleMapsUri: 'https://maps.google.com/water1', placeId: 'p5' },
  ],
  parks: [
    { name: 'Parque del Cid', lat: 42.34, lng: -3.70, distanceKm: 4, googleMapsUri: 'https://maps.google.com/park1', placeId: 'p6' },
  ],
};

const baseProps: MoreStopsModalProps = {
  isOpen: true,
  onClose: vi.fn(),
  legLabel: 'Day 3',
  stops: mockStops,
  loading: false,
  searchMode: 'along-route',
  onSearchModeChange: vi.fn(),
};

describe('MoreStopsModal', () => {
  it('renders when open', () => {
    render(<MoreStopsModal {...baseProps} />);
    expect(screen.getByText('More stops — Day 3')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<MoreStopsModal {...baseProps} isOpen={false} />);
    expect(screen.queryByText('More stops — Day 3')).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MoreStopsModal {...baseProps} onClose={onClose} />);
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows fuel tab as active by default', () => {
    render(<MoreStopsModal {...baseProps} />);
    const fuelTab = screen.getByRole('tab', { name: /fuel/i });
    expect(fuelTab).toHaveAttribute('aria-selected', 'true');
  });

  it('renders fuel stops in default tab', () => {
    render(<MoreStopsModal {...baseProps} />);
    expect(screen.getByText('Repsol Burgos Norte')).toBeInTheDocument();
    expect(screen.getByText('Cepsa Osorno')).toBeInTheDocument();
    expect(screen.getByText('BP Sahagún')).toBeInTheDocument();
  });

  it('switches to groceries tab', async () => {
    const user = userEvent.setup();
    render(<MoreStopsModal {...baseProps} />);
    await user.click(screen.getByRole('tab', { name: /groceries/i }));
    expect(screen.getByText('Aldi Palencia')).toBeInTheDocument();
    // fuel stops should not be visible
    expect(screen.queryByText('Repsol Burgos Norte')).not.toBeInTheDocument();
  });

  it('switches to water tab', async () => {
    const user = userEvent.setup();
    render(<MoreStopsModal {...baseProps} />);
    await user.click(screen.getByRole('tab', { name: /water/i }));
    expect(screen.getByText('Fuente Carrionas')).toBeInTheDocument();
  });

  it('switches to parks tab', async () => {
    const user = userEvent.setup();
    render(<MoreStopsModal {...baseProps} />);
    await user.click(screen.getByRole('tab', { name: /parks/i }));
    expect(screen.getByText('Parque del Cid')).toBeInTheDocument();
  });

  it('shows search mode toggle', () => {
    render(<MoreStopsModal {...baseProps} />);
    expect(screen.getByText('Along route')).toBeInTheDocument();
    expect(screen.getByText('Near dest.')).toBeInTheDocument();
  });

  it('calls onSearchModeChange when toggling', async () => {
    const onSearchModeChange = vi.fn();
    const user = userEvent.setup();
    render(<MoreStopsModal {...baseProps} onSearchModeChange={onSearchModeChange} />);
    await user.click(screen.getByText('Near dest.'));
    expect(onSearchModeChange).toHaveBeenCalledWith('near-destination');
  });

  it('shows loading state', () => {
    render(<MoreStopsModal {...baseProps} loading />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows empty state when no stops in category', async () => {
    const user = userEvent.setup();
    render(
      <MoreStopsModal
        {...baseProps}
        stops={{ fuel: [], groceries: [], water: [], parks: [] }}
      />
    );
    expect(screen.getByText(/no stops found/i)).toBeInTheDocument();
  });

  it('calls onClose when clicking overlay backdrop', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MoreStopsModal {...baseProps} onClose={onClose} />);
    const overlay = screen.getByTestId('modal-overlay');
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
