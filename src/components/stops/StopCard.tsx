'use client';

import type { StopType } from '@/types/trip';
import Distance from '@/components/Distance';
import { FuelIcon, PlaceIcon } from '@/components/icons';

export interface StopCardProps {
  stopType: StopType;
  name: string;
  distanceFromStartKm: number | null;
  /** Direct Google Maps URI for this place (preferred). */
  googleMapsUri?: string | null;
  /** Fallback coordinates when no googleMapsUri is available. */
  lat?: number | null;
  lng?: number | null;
  /** When true, dims the card and shows a spinner overlay. */
  loading?: boolean;
}

/**
 * Display labels + colors for each stop type in the redesigned UI.
 * Separate from the old TYPE_META (which used emoji icons).
 */
const STOP_DISPLAY: Record<
  StopType,
  { label: string; color: string; Icon: typeof FuelIcon }
> = {
  fuel: {
    label: 'FUEL',
    color: 'var(--tp-gold)',
    Icon: FuelIcon,
  },
  other: {
    label: 'STOP',
    color: 'var(--tp-muted)',
    Icon: PlaceIcon,
  },
};

function buildFallbackMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/**
 * Reusable stop card for the redesigned leg UI.
 *
 * Layout (Option B): icon + type/name/distance, plus an optional price line.
 * The entire card is a link that opens Google Maps in a new tab.
 */
export default function StopCard({
  stopType,
  name,
  distanceFromStartKm,
  googleMapsUri,
  lat,
  lng,
  loading = false,
}: StopCardProps) {
  const display = STOP_DISPLAY[stopType] ?? STOP_DISPLAY.other;

  const href =
    googleMapsUri ??
    (lat != null && lng != null ? buildFallbackMapsUrl(lat, lng) : null);

  const cardStyle: React.CSSProperties = {
    display: 'block',
    padding: '10px 12px',
    background: 'var(--tp-surface)',
    border: '1px solid var(--tp-border)',
    borderRadius: 8,
    marginBottom: 6,
    cursor: href ? 'pointer' : 'default',
    textDecoration: 'none',
    color: 'inherit',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const content = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/*
          A ring on the route line, not a tile. The old 32px filled square
          read as a button — it is a marker, and the same marker the map
          draws, so the list and the map describe one route rather than two
          representations of it.
        */}
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            background: 'var(--tp-bg)',
            border: `1px solid ${display.color}`,
          }}
        >
          <display.Icon color={display.color} size={13} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              color: display.color,
            }}
          >
            {display.label}
          </div>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 500,
              color: 'var(--tp-text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {name}
          </div>
          {distanceFromStartKm != null && (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--tp-subtle)',
                fontVariantNumeric: 'tabular-nums',
                marginTop: 1,
              }}
            >
              {/*
                Was a hardcoded `${Math.round(km)} km`, which made this the one
                distance on the trip screen that ignored the units preference
                entirely — an imperial user got kilometres here and nowhere
                else, with no miles at all. Every other distance goes through
                `Distance`; this one was written before it and never caught up.
              */}
              <Distance km={distanceFromStartKm} layout="inline" /> from start
            </div>
          )}
        </div>
        {href && (
          <div
            style={{
              fontSize: 14,
              color: 'var(--tp-subtle)',
              flexShrink: 0,
            }}
          >
            ↗
          </div>
        )}
      </div>
    </>
  );

  const loadingOverlay = loading ? (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(var(--tp-surface-rgb, 30,30,30), 0.6)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2,
      }}
    >
      <div
        style={{
          width: 18,
          height: 18,
          border: '2px solid var(--tp-border)',
          borderTopColor: 'var(--tp-primary)',
          borderRadius: '50%',
          animation: 'tp-spin 0.8s linear infinite',
        }}
      />
    </div>
  ) : null;

  const wrappedCardStyle: React.CSSProperties = {
    ...cardStyle,
    position: 'relative',
    opacity: loading ? 0.6 : 1,
    pointerEvents: loading ? 'none' : undefined,
  };

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={wrappedCardStyle}
        className="stop-card"
      >
        {loadingOverlay}
        {content}
      </a>
    );
  }

  return (
    <div
      style={wrappedCardStyle}
      className="stop-card"
    >
      {loadingOverlay}
      {content}
    </div>
  );
}
