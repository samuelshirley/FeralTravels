/**
 * The location toggle in Settings is honest in both directions.
 *
 * On: the switch calls `request`, which is what raises the browser dialog.
 * Off: a page cannot revoke its own permission, so the switch does NOT
 * animate off and change nothing — it is checked and disabled, and a sentence
 * names where the real control is. Asserted through the DOM.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const gps = vi.hoisted(() => ({
  value: {
    position: null as { lat: number; lng: number } | null,
    place: null as string | null,
    placeResolved: false,
    gpsStatus: 'unavailable' as string,
    enablePath: 'prompt' as string,
    request: vi.fn(),
  },
}));
vi.mock('@/components/DeviceLocationContext', () => ({
  DeviceLocationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDeviceLocation: () => gps.value,
}));

import LocationSection from './LocationSection';

afterEach(() => {
  cleanup();
  gps.value = { ...gps.value, gpsStatus: 'unavailable', enablePath: 'prompt', request: vi.fn() };
});

describe('LocationSection (web)', () => {
  it('off → on asks the browser', () => {
    render(<LocationSection />);
    const toggle = screen.getByRole('switch', { name: 'Location' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(gps.value.request).toHaveBeenCalledTimes(1);
  });

  it('on cannot be switched off by the page, and says so', () => {
    gps.value = { ...gps.value, gpsStatus: 'active', enablePath: 'none' };
    render(<LocationSection />);
    const toggle = screen.getByRole('switch', { name: 'Location' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    // Nothing was requested and nothing claims to have been revoked.
    expect(gps.value.request).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('settings-location-note')).toHaveTextContent(/address bar/);
    expect(screen.getByTestId('settings-location-status')).toHaveTextContent('On');
  });

  it('a spent permission is off, locked, and points at the browser', () => {
    gps.value = { ...gps.value, gpsStatus: 'denied', enablePath: 'settings' };
    render(<LocationSection />);
    const toggle = screen.getByRole('switch', { name: 'Location' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId('settings-location-note')).toHaveTextContent(/blocking location/);
  });

  it('renders nothing while the first read is in flight', () => {
    gps.value = { ...gps.value, gpsStatus: 'pending' };
    const { container } = render(<LocationSection />);
    expect(container).toBeEmptyDOMElement();
  });
});
