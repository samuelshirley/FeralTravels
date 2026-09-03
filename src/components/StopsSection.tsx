'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { FuelStatus, Stop, StopType } from '@/types/trip';
import { classifyFuelPlanError } from '@/lib/fuelPlanErrorSemantics';
import { apiFetch } from '@/lib/api';
import { StopCard } from './stops';
import { useStopActions } from './stops/useStopActions';
import Spinner from './Spinner';
import { buttonStyle } from '@/components/ui/Button';

interface StopsSectionProps {
  tripId: string;
  legId: string;
  legEndName: string | null;
  legEndCoords?: { lat: number | null; lng: number | null };
  legStartCoords?: { lat: number | null; lng: number | null };
  initialStops: Stop[];
  fuelStatus?: FuelStatus;
  fuelPlanError?: string | null;
  /**
   * True while the day-open lazy fuel search is in flight client-side. The
   * server flips fuel_status to 'computing', but the client won't see that
   * until the trip reloads — this drives the "Planning fuel stops…" spinner
   * immediately on open. See LegCard's lazy-fuel effect.
   */
  fuelLoading?: boolean;
  /**
   * True when the owning leg is a past day. Past days are read-history: we
   * suppress the "Planning fuel stops…" spinner entirely (LegCard also skips
   * the lazy fetch), so opening an old day never shows fuel planning running.
   */
  isPast?: boolean;
  onChanged?: () => void;
  readonly?: boolean;
  /**
   * Stop id to briefly ring after a map marker click scrolled here. The
   * matching card gets a highlight outline; the anchor (data-stop-anchor) is
   * the scroll target. Null = nothing highlighted.
   */
  highlightStopId?: string | null;
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

const TYPE_ORDER: StopType[] = ['fuel', 'other'];

export default function StopsSection({
  tripId,
  legId,
  legEndName: _legEndName,
  legEndCoords: _legEndCoords,
  legStartCoords: _legStartCoords,
  initialStops,
  fuelStatus = 'none',
  fuelPlanError = null,
  fuelLoading = false,
  isPast = false,
  onChanged,
  readonly = false,
  highlightStopId = null,
}: StopsSectionProps) {
  void _legEndName;
  void _legStartCoords;
  void _legEndCoords;

  const {
    activeStops,
    dismissedStops,
    syncInitialStops,
    remove,
    pasteValue,
    setPasteValue,
    pasteBusy,
    pasteError,
    addFromPaste,
  } = useStopActions({ tripId, legId, initialStops, onChanged });

  useEffect(() => {
    syncInitialStops(initialStops);
  }, [initialStops, syncInitialStops]);

  // --- Fuel planning UI state ---
  // `fuelLoading` reflects the client-initiated day-open search before the
  // trip reload surfaces the server's 'computing' status.
  // A past day never shows fuel planning as running — even if the leg was left
  // in a stale 'computing'/'pending' state, we don't re-plan history.
  const fuelPlanning =
    !isPast &&
    (fuelLoading || fuelStatus === 'computing' || fuelStatus === 'pending');
  const pathname = usePathname();
  const fuelErrorCategory = classifyFuelPlanError(fuelPlanError);
  const setupReturnTarget = pathname?.startsWith('/') ? pathname : `/trips/${tripId}`;
  const vehicleSetupHref = `/vehicle-setup?returnTo=${encodeURIComponent(setupReturnTarget)}`;

  // --- Sort stops for display: by distance from start, then type ---
  const sortedStops = useMemo(() => {
    return [...activeStops].sort((a, b) => {
      const distA = a.distance_from_start_km ?? Infinity;
      const distB = b.distance_from_start_km ?? Infinity;
      if (distA !== distB) return distA - distB;
      return TYPE_ORDER.indexOf(a.stop_type) - TYPE_ORDER.indexOf(b.stop_type);
    });
  }, [activeStops]);

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
                style={{ ...buttonStyle(), fontSize: 11, padding: '4px 10px' }}
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

        {/* Stops (fuel + user-added) */}
        {sortedStops.map((stop) => {
          const highlighted = highlightStopId === String(stop.id);
          return (
          <div
            key={stop.id}
            data-stop-anchor={String(stop.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              scrollMarginTop: 80,
              borderRadius: 8,
              boxShadow: highlighted ? '0 0 0 2px var(--tp-gold)' : 'none',
              transition: 'box-shadow 0.3s ease',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <StopCard
                stopType={stop.stop_type}
                name={stop.name}
                distanceFromStartKm={stop.distance_from_start_km}
                googleMapsUri={
                  stop.lat != null && stop.lng != null
                    ? `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`
                    : null
                }
                lat={stop.lat}
                lng={stop.lng}
                loading={false}
              />
            </div>
            {!readonly && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  remove(stop.id);
                }}
                aria-label={`Remove ${stop.name}`}
                title="Remove this stop"
                style={{
                  flexShrink: 0,
                  width: 28,
                  height: 28,
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 16,
                  lineHeight: 1,
                  background: 'transparent',
                  border: '1px solid var(--tp-border)',
                  borderRadius: 6,
                  color: 'var(--tp-muted)',
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            )}
          </div>
          );
        })}

        {sortedStops.length === 0 &&
          !fuelPlanning &&
          fuelStatus !== 'failed' &&
          fuelStatus !== 'no_stations_found' && (
            <div style={{ fontSize: 11, color: 'var(--tp-subtle)' }}>
              {fuelStatus === 'ready'
                ? // Sourced, and the planner verified nothing is needed — say so
                  // instead of the ambiguous "no stops yet" (which reads as
                  // "nothing happened"). Only claims what the tank math checked;
                  // no promises about when the next fuel stop comes.
                  'No fuel stop needed on this day — it fits within the fuel you have left.'
                : readonly
                  ? 'No stops.'
                  : 'No stops yet — fuel stops appear here automatically.'}
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
