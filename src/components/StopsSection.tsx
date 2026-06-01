'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { FuelStatus, Stop, StopType } from '@/types/trip';
import { classifyFuelPlanError } from '@/lib/fuelPlanErrorSemantics';
import { apiFetch } from '@/lib/api';
import { StopCard } from './stops';
import { useStopActions } from './stops/useStopActions';
import type { StopPhoto } from './stops';
import Spinner from './Spinner';

interface StopsSectionProps {
  tripId: string;
  legId: string;
  legEndName: string | null;
  legEndCoords?: { lat: number | null; lng: number | null };
  legStartCoords?: { lat: number | null; lng: number | null };
  initialStops: Stop[];
  fuelStatus?: FuelStatus;
  fuelPlanError?: string | null;
  onChanged?: () => void;
  readonly?: boolean;
}

const sectionCardStyle: CSSProperties = {
  marginTop: 12,
  padding: '10px 14px',
  background: 'var(--tp-surface-muted)',
  borderRadius: 6,
  border: '1px solid var(--tp-border)',
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  color: 'var(--tp-subtle)',
  marginBottom: 6,
};

const TYPE_ORDER: StopType[] = ['fuel', 'dump_station', 'food', 'overnight', 'rest', 'other'];

// Photos are now read directly from stop.photos (persisted in DB at planning time).

export default function StopsSection({
  tripId,
  legId,
  legEndName: _legEndName,
  legEndCoords: _legEndCoords,
  legStartCoords: _legStartCoords,
  initialStops,
  fuelStatus = 'none',
  fuelPlanError = null,
  onChanged,
  readonly = false,
}: StopsSectionProps) {
  void _legEndName;
  void _legStartCoords;
  void _legEndCoords;

  const {
    activeStops,
    dismissedStops,
    syncInitialStops,
    pasteValue,
    setPasteValue,
    pasteBusy,
    pasteError,
    addFromPaste,
  } = useStopActions({ tripId, legId, initialStops, onChanged });

  useEffect(() => {
    syncInitialStops(initialStops);
  }, [initialStops, syncInitialStops]);

  // --- "Find other station" state for dump station stops ---
  const [findingAlt, setFindingAlt] = useState<string | null>(null);

  const handleFindAlternative = useCallback(async (stopId: string) => {
    setFindingAlt(stopId);
    try {
      await apiFetch(`/api/stops/${stopId}/find-alternative`, {
        method: 'POST',
        body: {},
      });
      onChanged?.();
    } catch (err) {
      console.error('[StopsSection] find-alternative failed:', err);
    } finally {
      setFindingAlt(null);
    }
  }, [onChanged]);

  // --- Fuel planning UI state ---
  const fuelPlanning = fuelStatus === 'computing' || fuelStatus === 'pending';
  const pathname = usePathname();
  const fuelErrorCategory = classifyFuelPlanError(fuelPlanError);
  const setupReturnTarget = pathname?.startsWith('/') ? pathname : `/trips/${tripId}`;
  const vehicleSetupHref = `/vehicle-setup?returnTo=${encodeURIComponent(setupReturnTarget)}`;

  // --- Photos state ---
  // Photos are now persisted in the DB at planning time — no external API calls.
  // Build the photosMap from stop.photos directly.
  const photosMap = useMemo(() => {
    const map = new Map<string, StopPhoto[]>();
    for (const stop of activeStops) {
      map.set(stop.id.toString(), stop.photos ?? []);
    }
    return map;
  }, [activeStops]);

  // --- Sort stops for display ---
  const sortedStops = useMemo(() => {
    return [...activeStops].sort((a, b) => {
      const typeA = TYPE_ORDER.indexOf(a.stop_type);
      const typeB = TYPE_ORDER.indexOf(b.stop_type);
      // Overnight always last
      if (a.stop_type === 'overnight' && b.stop_type !== 'overnight') return 1;
      if (b.stop_type === 'overnight' && a.stop_type !== 'overnight') return -1;
      // Then by distance from start
      const distA = a.distance_from_start_km ?? Infinity;
      const distB = b.distance_from_start_km ?? Infinity;
      if (distA !== distB) return distA - distB;
      return typeA - typeB;
    });
  }, [activeStops]);

  const overnightStops = sortedStops.filter((s) => s.stop_type === 'overnight');
  const waypointStops = sortedStops.filter((s) => s.stop_type !== 'overnight');

  return (
    <>
      {/* STOPS */}
      <div style={sectionCardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={sectionTitleStyle}>STOPS</div>

        {/* Fuel planning status */}
        {!readonly && fuelPlanning && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Spinner size={10} thickness={2} color="var(--tp-gold)" />
            <span style={{ fontSize: 11, color: 'var(--tp-muted)' }}>Planning fuel stops…</span>
          </div>
        )}

        {/* Fuel error: vehicle profile */}
        {!readonly && fuelStatus === 'failed' && fuelErrorCategory === 'user_vehicle_profile' && (
          <div
            style={{
              marginBottom: 8,
              padding: '8px 10px',
              background: 'rgba(78,122,176,0.08)',
              border: '1px solid rgba(78,122,176,0.28)',
              borderRadius: 5,
              fontSize: 11,
              color: 'var(--tp-text)',
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: 'var(--tp-primary)' }}>Finish your vehicle profile</strong> so we
            can plan fuel stops along this leg.
            {fuelPlanError && (
              <span style={{ color: 'var(--tp-muted)' }}> {fuelPlanError}</span>
            )}
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <Link
                href={vehicleSetupHref}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '4px 10px',
                  borderRadius: 4,
                  background: 'var(--tp-primary)',
                  color: 'var(--tp-on-primary)',
                  textDecoration: 'none',
                }}
              >
                Open vehicle setup
              </Link>
            </div>
          </div>
        )}

        {/* Fuel error: platform */}
        {!readonly && fuelStatus === 'failed' && fuelErrorCategory !== 'user_vehicle_profile' && (
          <div
            style={{
              marginBottom: 8,
              padding: '8px 10px',
              background: 'rgba(198,93,74,0.08)',
              border: '1px solid rgba(198,93,74,0.3)',
              borderRadius: 5,
              fontSize: 11,
              color: 'var(--tp-danger)',
              lineHeight: 1.5,
            }}
          >
            <strong>
              {fuelErrorCategory === 'platform_config'
                ? 'Fuel planning paused (Places / Maps setup).'
                : 'Fuel planning failed.'}
            </strong>{' '}
            We&apos;ll retry automatically the next time you edit a stop or change the route.
            {fuelPlanError && (
              <span style={{ color: 'var(--tp-muted)' }}> {fuelPlanError}</span>
            )}
          </div>
        )}

        {/* No stations found within the widest search radius — a real warning,
            not a failure. Penny couldn't auto-plan a stop because the route is
            genuinely too remote; the user must carry extra fuel or plan a stop
            manually. Shown in readonly too — it's a safety signal. */}
        {fuelStatus === 'no_stations_found' && (
          <div
            style={{
              marginBottom: 8,
              padding: '8px 10px',
              background: 'rgba(214,158,46,0.1)',
              border: '1px solid rgba(214,158,46,0.4)',
              borderRadius: 5,
              fontSize: 11,
              color: 'var(--tp-text)',
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: 'var(--tp-warning, #b7791f)' }}>
              No fuel stations found along this leg.
            </strong>{' '}
            {fuelPlanError ??
              'This stretch is too remote for an auto-planned fuel stop — carry extra fuel or plan a stop manually.'}
          </div>
        )}

        {/* Waypoint stops (non-overnight) */}
        {waypointStops.map((stop) => (
          <div key={stop.id}>
            <StopCard
              stopType={stop.stop_type}
              name={stop.name}
              distanceFromStartKm={stop.distance_from_start_km}
              photos={photosMap.get(stop.id.toString()) ?? []}
              photosLoading={false}
              googleMapsUri={
                stop.lat != null && stop.lng != null
                  ? `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`
                  : null
              }
              lat={stop.lat}
              lng={stop.lng}
              loading={findingAlt === stop.id.toString()}
            />
            {!readonly && stop.stop_type === 'dump_station' && (
              <div style={{ textAlign: 'right', marginTop: -2, marginBottom: 6 }}>
                <button
                  onClick={() => handleFindAlternative(stop.id.toString())}
                  disabled={findingAlt != null}
                  style={{
                    fontSize: 11,
                    color: findingAlt === stop.id.toString() ? 'var(--tp-muted)' : 'var(--tp-primary)',
                    background: 'none',
                    border: 'none',
                    cursor: findingAlt != null ? 'default' : 'pointer',
                    padding: '2px 4px',
                    fontWeight: 500,
                    opacity: findingAlt != null && findingAlt !== stop.id.toString() ? 0.5 : 1,
                  }}
                >
                  {findingAlt === stop.id.toString() ? 'Searching…' : 'Find other station'}
                </button>
              </div>
            )}
          </div>
        ))}

        {waypointStops.length === 0 &&
          !fuelPlanning &&
          fuelStatus !== 'failed' &&
          fuelStatus !== 'no_stations_found' && (
            <div style={{ fontSize: 11, color: 'var(--tp-subtle)' }}>
              {readonly ? 'No stops.' : 'No stops yet — fuel stops appear here automatically.'}
            </div>
          )}

        {/* Overnight */}
        {overnightStops.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={sectionTitleStyle}>OVERNIGHT</div>
            {overnightStops.map((stop) => (
              <StopCard
                key={stop.id}
                stopType="overnight"
                variant="overnight"
                name={stop.name}
                distanceFromStartKm={stop.distance_from_start_km}
                photos={photosMap.get(stop.id.toString()) ?? []}
                photosLoading={false}
                googleMapsUri={
                  stop.lat != null && stop.lng != null
                    ? `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`
                    : null
                }
                lat={stop.lat}
                lng={stop.lng}
              />
            ))}
          </div>
        )}

        {/* Dismissed stops (collapsed) */}
        {dismissedStops.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 10,
                color: 'var(--tp-muted)',
                letterSpacing: '0.08em',
              }}
            >
              {dismissedStops.length} DISMISSED
            </summary>
            <div style={{ marginTop: 6 }}>
              {dismissedStops.map((stop) => (
                <StopCard
                  key={stop.id}
                  stopType={stop.stop_type}
                  name={stop.name}
                  distanceFromStartKm={stop.distance_from_start_km}
                  photos={[]}
                  googleMapsUri={
                    stop.lat != null && stop.lng != null
                      ? `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`
                      : null
                  }
                  lat={stop.lat}
                  lng={stop.lng}
                />
              ))}
            </div>
          </details>
        )}

        {/* Penny prompt for additional stops */}
        {!readonly && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              color: 'var(--tp-muted)',
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            Ask Penny for fuel, groceries, or other stops along the route
          </div>
        )}
      </div>

      {/* Paste GPS (kept for power users) */}
      {!readonly && (
        <div style={sectionCardStyle} onClick={(e) => e.stopPropagation()}>
          <div style={sectionTitleStyle}>PASTE GPS</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addFromPaste();
              }}
              placeholder="Paste GPS (48.8566, 2.3522) or a Google Maps URL"
              disabled={pasteBusy}
              style={{
                flex: '1 1 240px',
                minWidth: 180,
                padding: '6px 10px',
                background: 'var(--tp-surface-muted)',
                border: '1px solid var(--tp-border)',
                borderRadius: 4,
                color: 'var(--tp-text)',
                fontSize: 12,
                outline: 'none',
              }}
            />
            <button
              onClick={addFromPaste}
              disabled={pasteBusy || !pasteValue.trim()}
              style={{
                fontSize: 11,
                background: pasteBusy ? 'var(--tp-surface-muted)' : 'var(--tp-primary)',
                border: 'none',
                color: pasteBusy ? 'var(--tp-muted)' : 'var(--tp-on-primary)',
                padding: '6px 14px',
                borderRadius: 4,
                cursor: pasteBusy || !pasteValue.trim() ? 'default' : 'pointer',
                fontWeight: 600,
              }}
            >
              {pasteBusy ? 'Adding…' : 'Add'}
            </button>
          </div>
          {pasteError && (
            <div style={{ fontSize: 11, color: 'var(--tp-danger)', marginTop: 4 }}>
              {pasteError}
            </div>
          )}
        </div>
      )}

    </>
  );
}
