'use client';

import { DeviceLocationProvider, useDeviceLocation } from '@/components/DeviceLocationContext';
import { buttonStyle } from '@/components/ui/Button';

/**
 * Location permission, in Settings. Web counterpart of
 * `mobile/components/LocationSection.tsx`.
 *
 * The capability is NOT the same on the two platforms and the copy says so.
 * iOS can hand the user to the Settings app; a web page has no API that
 * reopens its own permission pane, so once a browser permission is denied the
 * only honest thing is a sentence naming where to change it. Offering a button
 * that silently fails would be worse than offering nothing — the user presses
 * it, nothing happens, and now they distrust the whole screen.
 *
 * `enablePath` carries that difference, which is why this branches on it
 * rather than on `gpsStatus`.
 */
export default function LocationSection() {
  /*
   * Its own provider, because Settings sits outside the trip screen's one.
   *
   * `promptAllowed={false}` is the important half: opening Settings must never
   * raise the system dialog by itself. The provider then reports 'unavailable'
   * for an unasked permission, `enablePath` reads that as 'prompt', and the
   * user gets a BUTTON — the dialog appears when they ask for it, which is the
   * whole point of putting this on a settings screen.
   */
  return (
    <DeviceLocationProvider promptAllowed={false}>
      <LocationSectionBody />
    </DeviceLocationProvider>
  );
}

function LocationSectionBody() {
  const { gpsStatus, enablePath, request } = useDeviceLocation();

  // 'pending' is the first fix still in flight — saying "Off" during it would
  // be wrong for the second it lasts, and flicker.
  if (gpsStatus === 'pending') return null;

  const granted = gpsStatus === 'active';

  return (
    <section style={{ padding: '20px 0' }} data-testid="settings-location-section">
      <h2 style={{ margin: 0, marginBottom: 6, fontSize: 17, fontWeight: 500, color: 'var(--tp-text)' }}>
        Location
      </h2>
      <p style={{ margin: 0, marginBottom: 14, fontSize: 13, color: 'var(--tp-muted)', lineHeight: 1.5 }}>
        Lets Penny plan from where you actually are, and puts you on the map.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: granted ? 'var(--tp-primary)' : 'var(--tp-border-strong)',
            }}
          />
          <span style={{ fontSize: 15, fontWeight: 500, color: 'var(--tp-text)' }}>
            {granted ? 'On' : 'Off'}
          </span>
        </span>

        {enablePath === 'prompt' && (
          <button
            type="button"
            onClick={request}
            style={{ ...buttonStyle(), fontSize: 13, padding: '8px 14px' }}
          >
            Turn on
          </button>
        )}
      </div>

      {enablePath === 'settings' && (
        <p style={{ margin: 0, marginTop: 10, fontSize: 11, color: 'var(--tp-subtle)', lineHeight: 1.45 }}>
          Your browser is blocking location for this site. Change it from the icon in the address
          bar — a page cannot reopen that setting itself.
        </p>
      )}
    </section>
  );
}
