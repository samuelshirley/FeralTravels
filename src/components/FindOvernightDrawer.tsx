'use client';

import { useEffect, useMemo, useState } from 'react';
import { tripApi } from '@/lib/api';
import { buildNavUrl } from '@/lib/maps';
import type { LegCoords } from '@/lib/maps';

interface Spot {
  id?: number;
  source: 'ioverlander' | 'park4night' | 'google_places';
  sourceId: string | null;
  name: string;
  lat: number;
  lng: number;
  category: string;
  isFree: boolean;
  description: string | null;
  sourceUrl: string | null;
  distanceKm?: number;
  driveTimeMinutes?: number;
  band?: 'short' | 'medium' | 'long';
}

interface FindOvernightDrawerProps {
  tripId: number;
  legId: number;
  legCoords: LegCoords;
  onClose: () => void;
  onAdded?: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  ioverlander: 'iOverlander',
  park4night: 'Park4Night',
  google_places: 'Google Places',
};

const BAND_LABELS: Record<NonNullable<Spot['band']>, string> = {
  short: '~3h drive',
  medium: '~5h drive',
  long: '~6-7h drive',
};

function formatDriveTime(minutes: number | undefined): string {
  if (minutes == null) return '';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/**
 * Modal-ish drawer that lists overnight spots near the current leg's start
 * point. The user can either open Google Maps directly to a spot OR add it
 * as a route option on the leg.
 *
 * Two modes:
 *   - mode='leg' (default): pre-fetched bands grouped by drive time. Shown on
 *     the LegCard "Find a spot near here" button.
 *   - mode='here': flat distance-sorted list. Triggered by the user choosing
 *     "near my current location" — uses Geolocation if available.
 */
export default function FindOvernightDrawer({
  tripId,
  legId,
  legCoords,
  onClose,
  onAdded,
}: FindOvernightDrawerProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [candidates, setCandidates] = useState<Spot[]>([]);
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'leg' | 'here'>('leg');
  const [adding, setAdding] = useState<string | null>(null); // sourceId being added

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (mode === 'leg') {
          const res = (await api.findOvernightForLeg(legId)) as {
            origin: { lat: number; lng: number };
            candidates: Spot[];
            banded?: Spot[];
            raw?: Spot[];
          };
          if (cancelled) return;
          setOrigin(res.origin);
          setCandidates(res.candidates ?? []);
          setSpots(res.banded ?? res.raw ?? []);
        } else {
          // Geolocation; bail on permission denial back to leg mode.
          const coords = await new Promise<GeolocationPosition>((resolve, reject) => {
            if (!navigator.geolocation) {
              reject(new Error('Geolocation not available'));
              return;
            }
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 8000,
            });
          });
          if (cancelled) return;
          const res = (await api.findOvernightHere(
            coords.coords.latitude,
            coords.coords.longitude,
            { radiusKm: 60 }
          )) as { origin: { lat: number; lng: number }; spots: Spot[] };
          if (cancelled) return;
          setOrigin(res.origin);
          setCandidates([]);
          setSpots(res.spots ?? []);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load overnight spots');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [api, legId, mode]);

  async function addAsRoute(spot: Spot) {
    const key = spot.sourceId || `${spot.source}:${spot.lat},${spot.lng}`;
    setAdding(key);
    try {
      const navUrl = buildNavUrl({
        start_lat: legCoords.start_lat,
        start_lng: legCoords.start_lng,
        end_lat: spot.lat,
        end_lng: spot.lng,
      });
      const links: Array<{ url: string; type: string; label: string }> = [];
      if (navUrl) {
        links.push({ url: navUrl, type: 'google_maps', label: 'Go' });
      }
      if (spot.sourceUrl) {
        const linkType =
          spot.source === 'ioverlander'
            ? 'ioverlander'
            : spot.source === 'park4night'
              ? 'park4night'
              : spot.category === 'dog_park'
                ? 'dog_park'
                : 'other';
        links.push({
          url: spot.sourceUrl,
          type: linkType,
          label: SOURCE_LABELS[spot.source] ?? 'Source',
        });
      }
      const bandLabel = spot.band ? BAND_LABELS[spot.band] : null;
      const driveLabel = formatDriveTime(spot.driveTimeMinutes);
      const labelPrefix = bandLabel
        ? `${driveLabel || bandLabel}: `
        : driveLabel
          ? `${driveLabel}: `
          : '';
      await api.addRoute(legId, {
        label: `${labelPrefix}${spot.name}`,
        description: spot.description ?? undefined,
        end_lat: spot.lat,
        end_lng: spot.lng,
        end_name: spot.name,
        end_source: spot.source,
        end_source_url: spot.sourceUrl ?? undefined,
        drive_time_minutes: spot.driveTimeMinutes ?? undefined,
        links,
      });
      onAdded?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add route');
    } finally {
      setAdding(null);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 560,
          maxHeight: '85vh',
          background: '#0F0F0F',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: 'rgba(255,255,255,0.45)',
                fontFamily: "'JetBrains Mono', monospace",
                textTransform: 'uppercase',
              }}
            >
              Find a spot
            </div>
            <div
              style={{
                fontSize: 14,
                color: 'rgba(255,255,255,0.85)',
                marginTop: 2,
              }}
            >
              {mode === 'leg' ? 'Free overnight spots along this leg' : 'Free overnight spots near my location'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.7)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '10px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {(['leg', 'here'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                fontSize: 11,
                background: mode === m ? '#7CB5E8' : 'transparent',
                border: '1px solid rgba(124,181,232,0.4)',
                color: mode === m ? '#000' : '#7CB5E8',
                padding: '4px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              {m === 'leg' ? 'From leg start' : 'Near me'}
            </button>
          ))}
        </div>

        <div style={{ overflow: 'auto', padding: 16, flex: 1 }}>
          {loading && <Loading />}
          {error && (
            <div
              style={{
                padding: 12,
                background: 'rgba(232,124,124,0.08)',
                border: '1px solid rgba(232,124,124,0.3)',
                color: '#E87C7C',
                borderRadius: 5,
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {!loading && !error && mode === 'leg' && candidates.length > 0 && (
            <Section title="Recommended (1 per drive-time band)">
              {candidates.map((s) => (
                <SpotRow
                  key={`cand-${s.source}-${s.sourceId ?? s.lat}`}
                  spot={s}
                  origin={origin}
                  legCoords={legCoords}
                  adding={adding === (s.sourceId || `${s.source}:${s.lat},${s.lng}`)}
                  onAdd={() => addAsRoute(s)}
                />
              ))}
            </Section>
          )}

          {!loading && !error && spots.length > 0 && (
            <Section
              title={
                mode === 'leg'
                  ? `All nearby spots (${spots.length})`
                  : `Within ~60km (${spots.length})`
              }
            >
              {spots.map((s) => (
                <SpotRow
                  key={`spot-${s.source}-${s.sourceId ?? `${s.lat},${s.lng}`}`}
                  spot={s}
                  origin={origin}
                  legCoords={legCoords}
                  adding={adding === (s.sourceId || `${s.source}:${s.lat},${s.lng}`)}
                  onAdd={() => addAsRoute(s)}
                />
              ))}
            </Section>
          )}

          {!loading && !error && spots.length === 0 && candidates.length === 0 && (
            <div
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'rgba(255,255,255,0.45)',
                fontSize: 13,
              }}
            >
              No free overnight spots found in this area. Try the &ldquo;Near me&rdquo; mode once
              you&rsquo;ve started driving.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: 'rgba(255,255,255,0.4)',
          fontFamily: "'JetBrains Mono', monospace",
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div
      style={{
        padding: 24,
        color: 'rgba(255,255,255,0.5)',
        fontSize: 13,
        textAlign: 'center',
      }}
    >
      Searching iOverlander, Park4Night and Google Places…
    </div>
  );
}

function SpotRow({
  spot,
  origin,
  legCoords,
  adding,
  onAdd,
}: {
  spot: Spot;
  origin: { lat: number; lng: number } | null;
  legCoords: LegCoords;
  adding: boolean;
  onAdd: () => void;
}) {
  const navUrl = buildNavUrl({
    start_lat: origin?.lat ?? legCoords.start_lat,
    start_lng: origin?.lng ?? legCoords.start_lng,
    end_lat: spot.lat,
    end_lng: spot.lng,
  });
  const driveLabel = formatDriveTime(spot.driveTimeMinutes);
  const distLabel =
    spot.distanceKm != null && spot.distanceKm < 1000
      ? `${spot.distanceKm < 10 ? spot.distanceKm.toFixed(1) : Math.round(spot.distanceKm)} km`
      : null;

  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 5,
        marginBottom: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
          alignItems: 'flex-start',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.9)', fontWeight: 500 }}>
              {spot.name}
            </span>
            <Badge color="#E8D57C">{SOURCE_LABELS[spot.source] || spot.source}</Badge>
            {spot.band && <Badge color="#7CB5E8">{BAND_LABELS[spot.band]}</Badge>}
            {!spot.band && driveLabel && <Badge color="#7CB5E8">{driveLabel}</Badge>}
            {distLabel && <Badge color="rgba(255,255,255,0.5)">{distLabel}</Badge>}
            {spot.category && spot.category !== 'other' && (
              <Badge color="rgba(255,255,255,0.5)">{spot.category.replace('_', ' ')}</Badge>
            )}
          </div>
          {spot.description && (
            <div
              style={{
                fontSize: 12,
                color: 'rgba(255,255,255,0.55)',
                marginTop: 4,
                lineHeight: 1.4,
              }}
            >
              {spot.description.length > 200
                ? `${spot.description.slice(0, 200)}…`
                : spot.description}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {navUrl && (
          <a
            href={navUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11,
              color: '#7CB5E8',
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid rgba(124,181,232,0.3)',
              background: 'rgba(124,181,232,0.08)',
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            ▶ Go
          </a>
        )}
        {spot.sourceUrl && (
          <a
            href={spot.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 11,
              color: '#E8D57C',
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid rgba(232,213,124,0.3)',
              background: 'rgba(232,213,124,0.08)',
              textDecoration: 'none',
            }}
          >
            ↗ Source
          </a>
        )}
        <button
          onClick={onAdd}
          disabled={adding}
          style={{
            fontSize: 11,
            color: '#7CE8A3',
            padding: '4px 10px',
            borderRadius: 4,
            border: '1px solid rgba(124,232,163,0.35)',
            background: adding ? 'rgba(124,232,163,0.04)' : 'rgba(124,232,163,0.12)',
            cursor: adding ? 'wait' : 'pointer',
            fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace",
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {adding ? 'Adding…' : '+ Add as route'}
        </button>
      </div>
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        background: color === 'rgba(255,255,255,0.5)' ? 'rgba(255,255,255,0.06)' : `${color}22`,
        color,
        padding: '2px 6px',
        borderRadius: 3,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {children}
    </span>
  );
}
