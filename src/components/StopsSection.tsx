'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { FuelStatus, Stop, StopType } from '@/types/trip';
import { classifyFuelPlanError } from '@/lib/fuelPlanErrorSemantics';
import { apiFetch } from '@/lib/api';
import { buildGoHereUrl } from '@/lib/maps';
import { formatKm } from '@/lib/units';
import { useUnits } from '@/components/UnitsContext';
import { StopCard } from './stops';
import { useStopActions } from './stops/useStopActions';
import Spinner from './Spinner';
import { buttonStyle } from '@/components/ui/Button';
import { CloseIcon, FuelIcon, NavigateIcon, PlaceIcon } from '@/components/icons';

interface StopsSectionProps {
  tripId: string;
  legId: string;
  legStartName: string | null;
  legEndName: string | null;
  legEndCoords?: { lat: number | null; lng: number | null };
  legStartCoords?: { lat: number | null; lng: number | null };
  /** Leg driving distance, for the DESTINATION row's marker. */
  legDistanceKm?: number | null;
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

/*
 * The one structural change in the reskin. `Itinerary` wrapped legs in a
 * card, `LegCard` drew another surface, and this file drew two more inside
 * that — STOPS and PASTE GPS — with StopCards nested inside those. Four
 * levels of border and fill for one day.
 *
 * A section inside the day card is now a hairline and a kicker. The card is
 * the day; everything within it is separated, not re-boxed.
 */
const sectionCardStyle: CSSProperties = {
  marginTop: 14,
  paddingTop: 12,
  borderTop: '1px solid var(--tp-neutral-900)',
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 600,
  letterSpacing: '0.13em',
  color: 'var(--tp-subtle)',
  marginBottom: 8,
};

const TYPE_ORDER: StopType[] = ['fuel', 'other'];

export default function StopsSection({
  tripId,
  legId,
  legStartName,
  legEndName,
  legEndCoords,
  legStartCoords,
  legDistanceKm,
  initialStops,
  fuelStatus = 'none',
  fuelPlanError = null,
  fuelLoading = false,
  isPast = false,
  onChanged,
  readonly = false,
  highlightStopId = null,
}: StopsSectionProps) {
  const {
    activeStops,
    dismissedStops,
    syncInitialStops,
    remove,
  } = useStopActions({ tripId, legId, initialStops, onChanged });
  const { units } = useUnits();

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

  /*
   * The timeline's rows: the leg's own START, every active stop in route
   * order, and its DESTINATION.
   *
   * The endpoints are rows rather than headings because they are places on the
   * same line — a driver reading "Reims Ids · 147 km" needs to know 147 km
   * from WHERE, and the answer used to be nowhere on the screen. `legStartName`
   * and the coords were already being passed to this component and explicitly
   * voided; this is what they were passed for.
   */
  const timelineRows = useMemo(() => {
    // Directions from wherever the device is, never a dropped pin.
    const mapsHref = buildGoHereUrl;

    type Row = {
      key: string;
      kicker: string;
      name: string;
      distanceKm: number | null;
      markerColor: string;
      icon: React.ReactNode;
      href: string | null;
      stop: Stop | null;
    };

    const rows: Row[] = [];

    if (legStartName) {
      rows.push({
        key: 'start',
        kicker: 'START',
        name: legStartName,
        distanceKm: 0,
        // A hollow neutral ring: you have already been here.
        markerColor: 'var(--tp-border-strong)',
        icon: null,
        href: mapsHref(legStartCoords?.lat, legStartCoords?.lng),
        stop: null,
      });
    }

    for (const stop of sortedStops) {
      const fuel = stop.stop_type === 'fuel';
      rows.push({
        key: String(stop.id),
        kicker: fuel ? 'FUEL' : 'STOP',
        name: stop.name,
        distanceKm: stop.distance_from_start_km,
        markerColor: fuel ? 'var(--tp-primary)' : 'var(--tp-muted)',
        icon: fuel ? <FuelIcon size={12} /> : <PlaceIcon size={12} />,
        href: mapsHref(stop.lat, stop.lng),
        stop,
      });
    }

    if (legEndName) {
      rows.push({
        key: 'destination',
        kicker: 'DESTINATION',
        name: legEndName,
        distanceKm: legDistanceKm ?? null,
        markerColor: 'var(--tp-primary)',
        icon: <PlaceIcon size={12} />,
        href: mapsHref(legEndCoords?.lat, legEndCoords?.lng),
        stop: null,
      });
    }

    return rows;
  }, [legStartName, legStartCoords, legEndName, legEndCoords, legDistanceKm, sortedStops]);

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

        {/*
          THE ROUTE TIMELINE. Stops used to be a stack of cards; they are rows
          on a line now — START, each stop in order, DESTINATION — so a day
          reads as a route rather than as an inventory.

          The connector is one absolutely-positioned element behind the
          markers rather than a segment per row: a per-row line leaves a hairline
          gap at every join, and the gaps are what make it look like a list of
          separate things again. It uses the same accent gradient the map paints
          on the route, so the two describe one journey.
        */}
        <div style={{ position: 'relative' }}>
          {timelineRows.length > 1 && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: 12,
                // Inset by half a marker at each end so the line starts and
                // stops INSIDE the first and last rings rather than poking out.
                top: 13,
                bottom: 13,
                width: 2,
                borderRadius: 1,
                background: 'linear-gradient(180deg, var(--tp-primary), var(--tp-accent-700))',
                boxShadow: '0 0 8px rgba(145, 132, 217, 0.55)',
              }}
            />
          )}

          {timelineRows.map((row) => {
            const highlighted = row.stop != null && highlightStopId === String(row.stop.id);
            /*
             * THE WHOLE ROW IS THE LINK. It used to be a div with a 30px
             * arrow at the end as the only clickable thing, so the obvious
             * press — the `FUEL / Shell / 390 km` row itself — did nothing.
             * The `×` remove control is a SIBLING of the link, not inside it,
             * so removing a stop can never also start a drive.
             */
            const rowBody = (
              <>
                <div
                  style={{
                    width: 26,
                    height: 26,
                    flexShrink: 0,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    // Opaque, so the connector passes behind rather than through.
                    background: 'var(--tp-bg)',
                    border: `1px solid ${row.markerColor}`,
                    color: row.markerColor,
                  }}
                >
                  {row.icon}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      letterSpacing: '0.13em',
                      color: 'var(--tp-subtle)',
                    }}
                  >
                    {row.kicker}
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      fontWeight: 500,
                      color: 'var(--tp-text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.name}
                  </div>
                </div>

                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--tp-subtle)',
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}
                >
                  {row.distanceKm != null ? formatKm(row.distanceKm, units) : ''}
                </div>

                {row.href && (
                  <span
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: 30,
                      height: 30,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--tp-accent-300)',
                      borderRadius: 6,
                    }}
                  >
                    <NavigateIcon size={15} />
                  </span>
                )}
              </>
            );
            const rowStyle: CSSProperties = {
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flex: 1,
              minWidth: 0,
              color: 'inherit',
              textDecoration: 'none',
            };
            return (
              <div
                key={row.key}
                data-stop-anchor={row.stop ? String(row.stop.id) : undefined}
                data-testid="stop-row"
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '7px 0',
                  scrollMarginTop: 80,
                  borderRadius: 8,
                  boxShadow: highlighted ? '0 0 0 2px var(--tp-primary)' : 'none',
                  transition: 'box-shadow 0.3s ease',
                }}
              >
                {row.href ? (
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${row.name} in Google Maps`}
                    title={`Navigate to ${row.name}`}
                    style={rowStyle}
                  >
                    {rowBody}
                  </a>
                ) : (
                  <div style={rowStyle}>{rowBody}</div>
                )}

                {row.stop && !readonly && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(row.stop!.id);
                    }}
                    aria-label={`Remove ${row.name}`}
                    title="Remove this stop"
                    style={{
                      flexShrink: 0,
                      width: 26,
                      height: 26,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--tp-subtle)',
                      cursor: 'pointer',
                    }}
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
            );
          })}
        </div>

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
                  googleMapsUri={buildGoHereUrl(stop.lat, stop.lng)}
                  lat={stop.lat}
                  lng={stop.lng}
                />
              ))}
            </div>
          </details>
        )}

      </div>

    </>
  );
}
