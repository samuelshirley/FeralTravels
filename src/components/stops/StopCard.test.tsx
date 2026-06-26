import { afterEach, describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StopCard from './StopCard';
import type { StopCardProps } from './StopCard';

afterEach(cleanup);

const baseProps: StopCardProps = {
  stopType: 'fuel',
  name: 'Repsol Burgos Norte',
  distanceFromStartKm: 62,
  photos: [
    { url: 'https://example.com/photo1.jpg', attribution: 'Google' },
    { url: 'https://example.com/photo2.jpg', attribution: 'Google' },
    { url: 'https://example.com/photo3.jpg', attribution: 'Google' },
  ],
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

  it('renders distance from start', () => {
    render(<StopCard {...baseProps} />);
    expect(screen.getByText('62 km from start')).toBeInTheDocument();
  });

  it('renders all photos', () => {
    render(<StopCard {...baseProps} />);
    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(3);
    expect(images[0]).toHaveAttribute('src', 'https://example.com/photo1.jpg');
  });

  it('opens Google Maps in new tab when clicked', () => {
    render(<StopCard {...baseProps} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://www.google.com/maps/place/Repsol+Burgos');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders different stop types correctly', () => {
    const { unmount } = render(<StopCard {...baseProps} stopType="food" />);
    expect(screen.getByText('GROCERIES')).toBeInTheDocument();
    unmount();

    const { unmount: u3 } = render(<StopCard {...baseProps} stopType="rest" />);
    expect(screen.getByText('PARK')).toBeInTheDocument();
    u3();

    render(<StopCard {...baseProps} stopType="overnight" />);
    expect(screen.getByText('OVERNIGHT')).toBeInTheDocument();
  });

  it('handles missing photos gracefully', () => {
    render(<StopCard {...baseProps} photos={[]} />);
    expect(screen.getByText('Repsol Burgos Norte')).toBeInTheDocument();
    expect(screen.queryAllByRole('img')).toHaveLength(0);
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

  it('renders overnight variant with distinct styling', () => {
    const { container } = render(
      <StopCard {...baseProps} stopType="overnight" variant="overnight" />
    );
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('overnight');
  });

  it('shows loading placeholders while photos are loading', () => {
    render(<StopCard {...baseProps} photosLoading />);
    const placeholders = screen.getAllByTestId('photo-placeholder');
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
  });
});
