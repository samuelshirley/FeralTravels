'use client';

import type { StopType } from '@/types/trip';

/** A single photo reference for display in a StopCard. */
export interface StopPhoto {
  url: string;
  attribution?: string;
}

export interface StopCardProps {
  stopType: StopType;
  name: string;
  distanceFromStartKm: number | null;
  photos: StopPhoto[];
  /** Direct Google Maps URI for this place (preferred). */
  googleMapsUri?: string | null;
  /** Fallback coordinates when no googleMapsUri is available. */
  lat?: number | null;
  lng?: number | null;
  /** Visual variant — 'overnight' gets accent-violet styling. */
  variant?: 'default' | 'overnight';
  /** Show shimmer placeholders instead of photos. */
  photosLoading?: boolean;
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
  food: {
    label: 'GROCERIES',
    color: 'var(--tp-accent-warm)',
    iconBg: 'rgba(201,123,99,0.15)',
    icon: '🛒',
  },
  overnight: {
    label: 'OVERNIGHT',
    color: '#8B7AB8',
    iconBg: 'rgba(107,91,154,0.15)',
    icon: '🌙',
  },
  rest: {
    label: 'PARK',
    color: 'var(--tp-success)',
    iconBg: 'rgba(74,139,122,0.15)',
    icon: '🌳',
  },
  other: {
    label: 'OTHER',
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
 * Layout (Option B): top row = icon + type/name/distance, bottom row = photos.
 * The entire card is a link that opens Google Maps in a new tab.
 */
export default function StopCard({
  stopType,
  name,
  distanceFromStartKm,
  photos,
  googleMapsUri,
  lat,
  lng,
  variant = 'default',
  photosLoading = false,
  loading = false,
}: StopCardProps) {
  const display = STOP_DISPLAY[stopType] ?? STOP_DISPLAY.other;

  const href =
    googleMapsUri ??
    (lat != null && lng != null ? buildFallbackMapsUrl(lat, lng) : null);

  const isOvernight = variant === 'overnight';

  const cardStyle: React.CSSProperties = {
    display: 'block',
    padding: '10px 12px',
    background: isOvernight ? 'rgba(107,91,154,0.07)' : 'var(--tp-surface)',
    border: `1px solid ${isOvernight ? 'rgba(107,91,154,0.2)' : 'var(--tp-border)'}`,
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
              {Math.round(distanceFromStartKm)} km from start
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

      {/* Photos row */}
      {photosLoading ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, paddingLeft: 44 }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              data-testid="photo-placeholder"
              style={{
                width: 72,
                height: 52,
                borderRadius: 6,
                background: 'var(--tp-border)',
                animation: 'tp-shimmer 1.5s ease-in-out infinite',
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      ) : photos.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, paddingLeft: 44 }}>
          {photos.slice(0, 3).map((photo, i) => (
            <img
              key={i}
              src={photo.url}
              alt={`${name} photo ${i + 1}`}
              style={{
                width: 72,
                height: 52,
                borderRadius: 6,
                objectFit: 'cover',
                flexShrink: 0,
                background: 'var(--tp-border)',
              }}
            />
          ))}
        </div>
      ) : null}
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
        className={isOvernight ? 'stop-card overnight' : 'stop-card'}
      >
        {loadingOverlay}
        {content}
      </a>
    );
  }

  return (
    <div
      style={wrappedCardStyle}
      className={isOvernight ? 'stop-card overnight' : 'stop-card'}
    >
      {loadingOverlay}
      {content}
    </div>
  );
}
