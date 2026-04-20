'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  legEndName?: string | null;
  onClose: () => void;
  onAdded?: () => void;
}

type Mode = 'destination' | 'here';
type RadiusKm = 10 | 50 | 100;

const RADII: RadiusKm[] = [10, 50, 100];
const DEFAULT_RADIUS_BY_MODE: Record<Mode, RadiusKm> = {
  destination: 50,
  here: 10,
};

const SOURCE_LABELS: Record<string, string> = {
  ioverlander: 'iOverlander',
  park4night: 'Park4Night',
  google_places: 'Google Places',
};

function formatDriveTime(minutes: number | undefined): string {
  if (minutes == null) return '';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/**
 * Modal-ish drawer that finds overnight spots for the user.
 *
 * Flow:
 *   1. Pick a mode — Near destination (uses leg.end_lat/end_lng) or Near me
 *      (browser geolocation).
 *   2. Pick a radius — 10 / 50 / 100 km chips. Default 50 for destination,
 *      10 for near-me.
 *   3. Results render sorted by distance. Header shows an editable
 *      "Near X · 50 km" chip; tap to change mode or radius.
 *
 * The banded "Recommended per drive-time" presentation lives in Penny's
 * internal prefetch (see src/lib/claude.ts), not this manual drawer.
 */
export default function FindOvernightDrawer({
  tripId,
  legId,
  legCoords,
  legEndName,
  onClose,
  onAdded,
}: FindOvernightDrawerProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);

  const [mode, setMode] = useState<Mode | null>(null);
  const [radius, setRadius] = useState<RadiusKm | null>(null);
  const [hereCoords, setHereCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const [spots, setSpots] = useState<Spot[]>([]);
  const [origin, setOrigin] = useState<{ lat: number; lng: number; name?: string | null } | null>(
    null
  );
  const [sourceErrors, setSourceErrors] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  // Step state derived from mode+radius: picker = needs input, results = run fetch.
  const step: 'mode' | 'radius' | 'results' =
    mode == null ? 'mode' : radius == null ? 'radius' : 'results';

  const requestGeo = useCallback(async (): Promise<boolean> => {
    setGeoBusy(true);
    setGeoError(null);
    try {
      const coords = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Geolocation is not available in this browser'));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        });
      });
      setHereCoords({ lat: coords.coords.latitude, lng: coords.coords.longitude });
      return true;
    } catch (e) {
      // GeolocationPositionError codes: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
      const code = (e as { code?: number })?.code;
      if (code === 1) {
        setGeoError('Location permission denied. Enable it in your browser settings and try again.');
      } else if (code === 3) {
        setGeoError('Location lookup timed out. Try moving outside or retry in a moment.');
      } else if (code === 2) {
        setGeoError('Your device could not determine its position. Try again in a moment.');
      } else {
        setGeoError(e instanceof Error ? e.message : 'Could not get your location');
      }
      return false;
    } finally {
      setGeoBusy(false);
    }
  }, []);

  const pickMode = useCallback(
    async (m: Mode) => {
      setMode(m);
      setRadius(null);
      setSpots([]);
      setOrigin(null);
      setSourceErrors({});
      setFatalError(null);
      if (m === 'here') {
        const ok = await requestGeo();
        if (!ok) {
          // Stay on the radius step so the user can see the error and retry;
          // they can also hit Change and pick "Near destination" instead.
        }
      }
    },
    [requestGeo]
  );

  const fetchedRef = useRef<string>('');
  useEffect(() => {
    if (step !== 'results' || mode == null || radius == null) return;
    const key = `${mode}-${radius}-${hereCoords?.lat ?? 'leg'}-${hereCoords?.lng ?? 'leg'}`;
    if (fetchedRef.current === key) return;
    fetchedRef.current = key;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setFatalError(null);
      setSourceErrors({});
      try {
        if (mode === 'destination') {
          const res = (await api.findOvernightForLeg(legId, { radiusKm: radius })) as {
            origin: { lat: number; lng: number; name?: string | null };
            spots?: Spot[];
            raw?: Spot[];
            banded?: Spot[];
            sourceErrors?: Record<string, string | null>;
          };
          if (cancelled) return;
          setOrigin(res.origin);
          setSpots(res.spots ?? res.raw ?? []);
          setSourceErrors(res.sourceErrors ?? {});
        } else {
          if (!hereCoords) {
            setFatalError('Location unavailable — tap Change and try again.');
            return;
          }
          const res = (await api.findOvernightHere(hereCoords.lat, hereCoords.lng, {
            radiusKm: radius,
          })) as {
            origin: { lat: number; lng: number; name?: string | null };
            spots: Spot[];
            sourceErrors?: Record<string, string | null>;
          };
          if (cancelled) return;
          setOrigin(res.origin);
          setSpots(res.spots ?? []);
          setSourceErrors(res.sourceErrors ?? {});
        }
      } catch (e) {
        if (!cancelled) {
          setFatalError(e instanceof Error ? e.message : 'Failed to load overnight spots');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, mode, radius, hereCoords, api, legId]);

  const resetToPicker = () => {
    setMode(null);
    setRadius(null);
    setSpots([]);
    setOrigin(null);
    setSourceErrors({});
    setFatalError(null);
    fetchedRef.current = '';
  };

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
      const driveLabel = formatDriveTime(spot.driveTimeMinutes);
      const labelPrefix = driveLabel ? `${driveLabel}: ` : '';
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
      setFatalError(e instanceof Error ? e.message : 'Failed to add route');
    } finally {
      setAdding(null);
    }
  }

  const headerSubtitle =
    step === 'results'
      ? mode === 'destination'
        ? `Near ${origin?.name || legEndName || 'destination'}`
        : 'Near my current location'
      : step === 'radius'
        ? mode === 'destination'
          ? `Near ${legEndName || 'destination'}`
          : 'Near me'
        : 'Where should we look?';

  const radiusChipLabel = radius ? `${radius} km` : null;

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
          <div style={{ minWidth: 0 }}>
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
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {headerSubtitle}
              </span>
              {step === 'results' && radiusChipLabel && (
                <button
                  onClick={resetToPicker}
                  title="Change mode or radius"
                  style={{
                    fontSize: 10,
                    fontFamily: "'JetBrains Mono', monospace",
                    background: 'rgba(124,181,232,0.14)',
                    border: '1px solid rgba(124,181,232,0.35)',
                    color: '#7CB5E8',
                    padding: '3px 8px',
                    borderRadius: 10,
                    cursor: 'pointer',
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                  }}
                >
                  {radiusChipLabel} · change
                </button>
              )}
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
              flexShrink: 0,
            }}
          >
            Close
          </button>
        </div>

        <div style={{ overflow: 'auto', padding: 16, flex: 1 }}>
          {step === 'mode' && (
            <ModePicker onPick={pickMode} legEndName={legEndName} />
          )}

          {step === 'radius' && mode != null && (
            <RadiusPicker
              mode={mode}
              onBack={() => {
                setMode(null);
                setGeoError(null);
              }}
              onPick={(r) => setRadius(r)}
              geoBusy={geoBusy}
              geoError={geoError}
              geoReady={mode !== 'here' || hereCoords != null}
              onRetryGeo={requestGeo}
            />
          )}

          {step === 'results' && (
            <>
              {Object.entries(sourceErrors).some(([, msg]) => msg) && (
                <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(Object.entries(sourceErrors) as Array<[string, string | null]>).map(
                    ([src, msg]) =>
                      msg ? (
                        <span
                          key={src}
                          title={msg}
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            background: 'rgba(232,124,124,0.12)',
                            border: '1px solid rgba(232,124,124,0.35)',
                            color: '#E87C7C',
                            padding: '3px 7px',
                            borderRadius: 3,
                            fontFamily: "'JetBrains Mono', monospace",
                          }}
                        >
                          {SOURCE_LABELS[src] ?? src} unreachable
                        </span>
                      ) : null
                  )}
                </div>
              )}

              {loading && <Loading />}

              {!loading && fatalError && (
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
                  {fatalError}
                </div>
              )}

              {!loading && !fatalError && spots.length > 0 && (
                <Section title={`${spots.length} spot${spots.length === 1 ? '' : 's'} within ${radius} km`}>
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

              {!loading && !fatalError && spots.length === 0 && (
                <EmptyState
                  allFailed={Object.values(sourceErrors).every((v) => !!v) && Object.keys(sourceErrors).length > 0}
                  onWiden={() => {
                    setRadius(null);
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ModePicker({
  onPick,
  legEndName,
}: {
  onPick: (m: Mode) => void;
  legEndName?: string | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <BigChoice
        onClick={() => onPick('destination')}
        title={`Near ${legEndName || 'destination'}`}
        subtitle="Free overnight spots around where this leg ends"
      />
      <BigChoice
        onClick={() => onPick('here')}
        title="Near me"
        subtitle="Use my current location — works while driving"
      />
    </div>
  );
}

function RadiusPicker({
  mode,
  onPick,
  onBack,
  geoBusy,
  geoError,
  geoReady,
  onRetryGeo,
}: {
  mode: Mode;
  onPick: (r: RadiusKm) => void;
  onBack: () => void;
  geoBusy: boolean;
  geoError: string | null;
  geoReady: boolean;
  onRetryGeo: () => void;
}) {
  const defaultRadius = DEFAULT_RADIUS_BY_MODE[mode];
  const disabled = mode === 'here' && !geoReady;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button
        onClick={onBack}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: 'none',
          color: 'rgba(255,255,255,0.55)',
          fontSize: 12,
          cursor: 'pointer',
          padding: 0,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        ← back
      </button>

      {mode === 'here' && geoBusy && (
        <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
          Waiting for your location…
        </div>
      )}
      {mode === 'here' && geoError && (
        <div
          style={{
            padding: 12,
            background: 'rgba(232,124,124,0.08)',
            border: '1px solid rgba(232,124,124,0.3)',
            color: '#E87C7C',
            borderRadius: 5,
            fontSize: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <span>{geoError}</span>
          <button
            onClick={onRetryGeo}
            style={{
              alignSelf: 'flex-start',
              background: 'rgba(124,181,232,0.2)',
              border: '1px solid rgba(124,181,232,0.4)',
              color: '#7CB5E8',
              padding: '4px 10px',
              borderRadius: 4,
              fontSize: 11,
              cursor: 'pointer',
              fontWeight: 600,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: '0.04em',
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.1em',
            color: 'rgba(255,255,255,0.45)',
            fontFamily: "'JetBrains Mono', monospace",
            textTransform: 'uppercase',
            marginBottom: 10,
          }}
        >
          Search radius
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8,
          }}
        >
          {RADII.map((r) => (
            <button
              key={r}
              onClick={() => onPick(r)}
              disabled={disabled}
              style={{
                background: r === defaultRadius ? 'rgba(124,181,232,0.15)' : 'rgba(255,255,255,0.04)',
                border:
                  r === defaultRadius
                    ? '1px solid rgba(124,181,232,0.55)'
                    : '1px solid rgba(255,255,255,0.1)',
                color: disabled ? 'rgba(255,255,255,0.3)' : r === defaultRadius ? '#7CB5E8' : '#fff',
                padding: '16px 12px',
                borderRadius: 6,
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontSize: 16,
                fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace",
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span>{r} km</span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '0.08em',
                  color: 'rgba(255,255,255,0.4)',
                }}
              >
                {r === 10 ? 'TIGHT' : r === 50 ? 'WIDE' : 'VERY WIDE'}
              </span>
            </button>
          ))}
        </div>
        <p
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.4)',
            marginTop: 10,
            lineHeight: 1.5,
          }}
        >
          Default highlighted. Start tight — pick bigger if nothing useful comes back.
        </p>
      </div>
    </div>
  );
}

function BigChoice({
  title,
  subtitle,
  onClick,
}: {
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'rgba(124,181,232,0.08)',
        border: '1px solid rgba(124,181,232,0.3)',
        color: '#fff',
        textAlign: 'left',
        padding: '16px 18px',
        borderRadius: 8,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 700, color: '#7CB5E8' }}>{title}</span>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{subtitle}</span>
    </button>
  );
}

function EmptyState({
  allFailed,
  onWiden,
}: {
  allFailed: boolean;
  onWiden: () => void;
}) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: 'center',
        color: 'rgba(255,255,255,0.6)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {allFailed ? (
        <>
          <div style={{ color: '#E87C7C', fontWeight: 600, marginBottom: 6 }}>
            All overnight-spot sources are unreachable right now.
          </div>
          <div style={{ fontSize: 12 }}>Please try again in a moment.</div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            No free overnight spots inside this radius.
          </div>
          <button
            onClick={onWiden}
            style={{
              background: 'rgba(124,181,232,0.15)',
              border: '1px solid rgba(124,181,232,0.4)',
              color: '#7CB5E8',
              padding: '8px 16px',
              borderRadius: 5,
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600,
              fontFamily: "'JetBrains Mono', monospace",
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Try a wider radius
          </button>
        </>
      )}
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
