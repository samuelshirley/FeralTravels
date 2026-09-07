'use client';

import { DeviceLocationProvider, useDeviceLocation } from '@/components/DeviceLocationContext';

/**
 * Location permission, in Settings. Web counterpart of
 * `mobile/components/LocationSection.tsx`.
 *
 * A TOGGLE, and an honest one. Turning it ON is the part a page can do: the
 * switch calls `request` and the browser's own dialog appears. Turning it OFF
 * is the part a page cannot do — no browser lets a site revoke its own
 * permission — so the switch does not pretend: once location is on it sits
 * checked and disabled, and a sentence says where the real control is. A
 * switch that animates off and changes nothing would be worse than no switch
 * (the user presses it, nothing happens, and now they distrust the screen).
 *
 * iOS can at least hand the user to the Settings app for the off path; that
 * is why the native section's switch is live in both directions and this one
 * is live in one. `enablePath` carries the difference, which is why this
 * branches on it rather than on `gpsStatus`.
 */
export default function LocationSection() {
  /*
   * Its own provider, because Settings sits outside the trip screen's one.
   *
   * `promptAllowed={false}` is the important half: opening Settings must never
   * raise the system dialog by itself. The provider then reports 'unavailable'
   * for an unasked permission, `enablePath` reads that as 'prompt', and the
   * dialog fires only when the switch is flipped — which is the whole point of
   * putting this on a settings screen.
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
  // The only flip the page can perform: off → on, from the never-asked state.
  const canTurnOn = !granted && enablePath === 'prompt';

  const note = granted
    ? "To turn it off, use the location icon in your browser's address bar — a page can't switch its own permission off."
    : enablePath === 'settings'
      ? 'Your browser is blocking location for this site. Change it from the icon in the address bar — a page cannot reopen that setting itself.'
      : enablePath === 'none'
        ? 'This browser has no location support.'
        : null;

  return (
    <section style={{ padding: '20px 0' }} data-testid="settings-location-section">
      <h2 style={{ margin: 0, marginBottom: 6, fontSize: 17, fontWeight: 500, color: 'var(--tp-text)' }}>
        Location
      </h2>
      <p style={{ margin: 0, marginBottom: 14, fontSize: 13, color: 'var(--tp-muted)', lineHeight: 1.5 }}>
        Lets Penny plan from where you actually are, and puts you on the map.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span
          style={{ fontSize: 15, fontWeight: 500, color: 'var(--tp-text)' }}
          data-testid="settings-location-status"
        >
          {granted ? 'On' : 'Off'}
        </span>

        <button
          type="button"
          role="switch"
          aria-checked={granted}
          aria-label="Location"
          data-testid="settings-location-toggle"
          disabled={!canTurnOn}
          onClick={() => {
            if (canTurnOn) request();
          }}
          style={{
            position: 'relative',
            width: 44,
            height: 26,
            padding: 0,
            border: `1px solid ${granted ? 'var(--tp-primary)' : 'var(--tp-border-strong)'}`,
            borderRadius: 999,
            background: granted ? 'var(--tp-primary)' : 'var(--tp-surface-muted)',
            cursor: canTurnOn ? 'pointer' : 'default',
            opacity: !canTurnOn && !granted ? 0.6 : 1,
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 2,
              left: granted ? 20 : 2,
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: granted ? 'var(--tp-on-primary)' : 'var(--tp-text)',
              transition: 'left 0.15s',
            }}
          />
        </button>
      </div>

      {note && (
        <p
          style={{ margin: 0, marginTop: 10, fontSize: 11, color: 'var(--tp-subtle)', lineHeight: 1.45 }}
          data-testid="settings-location-note"
        >
          {note}
        </p>
      )}
    </section>
  );
}
