'use client';

import type { StopType } from '@/types/trip';
import Distance from '@/components/Distance';

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
  { label: string; color: string; iconBg: string; icon: string }
> = {
  fuel: {
    label: 'FUEL',
    color: 'var(--tp-gold)',
    iconBg: 'rgba(184,149,106,0.15)',
    icon: '⛽',
  },
  other: {
    label: 'STOP',
    color: 'var(--tp-muted)',
    iconBg: 'rgba(92,92,92,0.1)',
    icon: '📍',
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
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            flexShrink: 0,
            background: display.iconBg,
          }}
        >
          {display.icon}
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
              fontSize: 13,
              fontWeight: 600,
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
              style={{ fontSize: 11, color: 'var(--tp-subtle)', marginTop: 1 }}
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
