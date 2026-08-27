'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LegWithDetails } from '@/types/trip';
import { tripApi } from '@/lib/api';
import { FUEL_CACHE_TTL_MS } from '@/lib/fuelCache';
import {
  assertDestinationReachable,
  buildLegDirectionsUrl,
  buildSegmentedNavUrls,
  isStationaryLeg,
  legDirectionsWaypoints,
  orderNavSegments,
} from '@/lib/maps';
import { useNextStop } from '@/lib/useNextStop';
import StatusBadge from './StatusBadge';
import Spinner from './Spinner';
import StopsSection from './StopsSection';
import Distance from './Distance';

/** Format a stop type slug into a readable label for nav buttons. */
function formatStopType(stopType?: string): string {
  switch (stopType) {
    case 'fuel': return 'Fuel';
    case 'destination': return 'Destination';
    case 'other': return 'Stop';
    default: return 'Stop';
  }
}

/** Build "Route to {Type} — {Name}" label for nav buttons. */
function navButtonLabel(seg: { label: string; stopType?: string }): string {
  return `Route to ${formatStopType(seg.stopType)} — ${seg.label}`;
}

interface LegCardProps {
  tripId: string;
  leg: LegWithDetails;
  expanded: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  onTrailsChanged?: () => void;
  onChanged?: () => void;
  readonly?: boolean;
  /**
   * Computed date string for this leg, e.g. "Wed 28 May" (metric) or
   * "Wed May 28" (imperial). Null when the trip has no confirmed start date
   * — falls back to leg.label or "Day N".
   */
  dateLabel?: string | null;
  /**
   * True while a fuel replan is in flight for the trip. The "Open in Google
   * Maps" link composes its waypoints from the trip's stops, so during a
   * replan the URL is briefly stale (waypoints from the previous plan).
   * We render a loading affordance so the user knows the link will update
   * shortly — link stays clickable; opening it works, the route just won't
   * include the latest fuel stops yet.
   */
  isFuelSyncing?: boolean;
  /** Total number of legs in the trip — used in the syncing tooltip copy. */
  fuelSyncTotalLegs?: number;
  /**
   * Stop id to briefly highlight (ring) after a map marker click landed here.
   * Forwarded to StopsSection so the matching StopCard pulses. Null = none.
   */
  highlightStopId?: string | null;
  /**
   * True when this leg sits in the collapsed "Behind you" section — a day the
   * driver has already passed (before the progress/calendar cutoff). NOTE: this
   * is cutoff membership, NOT simply date_iso < today — the *current* leg can
   * carry a stale past date after a progress re-anchor yet must still plan fuel.
   * Past days are read-history: we do NOT lazily source fuel for them on open
   * and we suppress the "Planning fuel stops…" spinner, so opening an old day
   * is instant and quiet.
   */
  isPast?: boolean;
}

export default function LegCard({
  tripId,
  leg,
  expanded,
  onToggle,
  onNavigate,
  onChanged,
  readonly = false,
  dateLabel,
  isFuelSyncing = false,
  fuelSyncTotalLegs,
  highlightStopId = null,
  isPast = false,
}: LegCardProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const isRestDay = leg.leg_type === 'rest';
  const driveHours = leg.drive_time_minutes ? (leg.drive_time_minutes / 60).toFixed(1) : null;
  const totalCost = leg.costs.find((c) => c.is_total);
  const itemCosts = leg.costs.filter((c) => !c.is_total);

  const selectedRoute = leg.routes.find((r) => r.status === 'selected') ?? null;
  const legCoords = {
    start_lat: leg.start_lat,
    start_lng: leg.start_lng,
    end_lat: leg.end_lat,
    end_lng: leg.end_lng,
  };
  const navWaypointCount = legDirectionsWaypoints(leg.stops).length;
  const navSegments = buildSegmentedNavUrls({
    legCoords,
    endName: leg.end_name,
    selectedRoute,
    stops: leg.stops,
    // distance + drive time tell a rest day (nothing to drive to) apart from a
    // day-loop that returns to its own start (which still needs a button home).
    distanceKm: leg.distance_km,
    driveTimeMinutes: leg.drive_time_minutes,
  });
  // Fallback single URL for the syncing state (doesn't need segments)
  const directionsUrl = buildLegDirectionsUrl({ legCoords, selectedRoute, stops: leg.stops });

  // GPS-aware "next stop" — only requests location when card is expanded.
  const legStart = leg.start_lat != null && leg.start_lng != null
    ? { lat: leg.start_lat, lng: leg.start_lng }
    : null;
  const { nextStop, allSegments, isNearRoute, gpsStatus } = useNextStop(
    navSegments,
    legStart,
    expanded,
  );
  /**
   * GPS may re-ORDER the nav buttons. It may never remove one.
   *
   * This used to be `showSmartNav`, which swapped the whole list for a single
   * next-stop button whenever GPS was active and the device was near the route.
   * "Near the route" includes standing at the leg's start — i.e. at home, weeks
   * before departure, for anyone whose trips begin where they live. The card then
   * offered one link to an unselected fuel stop and no way to reach the day's
   * destination at all. See orderNavSegments.
   */
  const promoteNext = gpsStatus === 'active' && isNearRoute && nextStop != null;
  const navButtons = useMemo(
    () => orderNavSegments(allSegments, promoteNext ? nextStop : null),
    [allSegments, promoteNext, nextStop],
  );
  // Fails loudly in dev and in tests; logs in production. The destination button
  // is not allowed to go missing again, quietly or otherwise.
  assertDestinationReachable(
    navButtons,
    `leg ${leg.id} (${leg.start_name} → ${leg.end_name})`,
    // Same inputs buildSegmentedNavUrls used to decide whether to emit a
    // destination at all, so the assertion and the builder cannot disagree.
    {
      stationary:
        leg.end_lat != null &&
        leg.end_lng != null &&
        isStationaryLeg({
          legCoords,
          destination: { lat: leg.end_lat, lng: leg.end_lng },
          distanceKm: leg.distance_km,
          driveTimeMinutes: leg.drive_time_minutes,
        }),
    }
  );

  // ── Lazy fuel sourcing on day-open ──────────────────────────────────────
  // Fuel stops are sourced when the user OPENS a day (no eager trip-wide
  // planning — that was the Google Places cost sink). When this card expands,
  // we POST to the leg's lazy fuel endpoint, which is cache-aware: a leg
  // sourced within FUEL_CACHE_TTL_MS is a server-side cache hit (zero Places
  // calls); a never-sourced or stale leg runs the real search. We mirror that
  // freshness check here so we don't even round-trip on a fresh cache.
  const [fuelLoading, setFuelLoading] = useState(false);
  const fuelFetchSigRef = useRef<string | null>(null);

  useEffect(() => {
    // Never source fuel for a past day — that drive is already behind the
    // driver. Skipping here also keeps `fuelLoading` false so no spinner shows.
    if (readonly || isRestDay || !expanded || isPast) return;
    const updatedAt = leg.fuel_stops_updated_at;
    const fresh = updatedAt
      ? Date.now() - Date.parse(updatedAt) < FUEL_CACHE_TTL_MS
      : false;
    const terminalSuccess =
      leg.fuel_status === 'ready' || leg.fuel_status === 'no_stations_found';
    // Source lazily when never sourced ('none'), a terminal-success cache that
    // has gone stale, OR a prior 'failed'. We auto-retry 'failed' — the Google
    // station/route calls are cheap and cache-guarded, so a retry self-heals
    // legs stranded on a stale/transient error. We still skip
    // 'computing'/'pending' (a search is already in flight); the
    // signature guard below stops duplicate fires within a render session.
    const needsFetch =
      leg.fuel_status === 'none' ||
      leg.fuel_status === 'failed' ||
      (terminalSuccess && !fresh);
    if (!needsFetch) return;

    // Guard against duplicate fires: the effect re-runs on every trip reload.
    // The signature folds in the fuel state, so once a fetch lands new data the
    // guard naturally allows a future genuinely-new state through.
    const sig = `${leg.id}:${leg.fuel_status}:${updatedAt ?? 'none'}`;
    if (fuelFetchSigRef.current === sig) return;
    fuelFetchSigRef.current = sig;

    let cancelled = false;
    setFuelLoading(true);
    api
      .planFuelStops(leg.id)
      .then(() => {
        // Reload the trip so the freshly-sourced stops + new fuel_status render.
        // Safe to call even if this card unmounted — it's a parent reload.
        onChanged?.();
      })
      .catch((e) => {
        // apiFetch already surfaced this via the global ErrorNotifier (no silent
        // swallow). Clear the guard so the next open can retry.
        fuelFetchSigRef.current = null;
        console.warn('lazy fuel fetch failed', e);
      })
      .finally(() => {
        if (!cancelled) setFuelLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    expanded,
    isRestDay,
    readonly,
    isPast,
    leg.id,
    leg.fuel_status,
    leg.fuel_stops_updated_at,
    api,
    onChanged,
  ]);

  /*
   * "Base day" is the user-facing name for `leg_type: 'rest'`.
   *
   * They were called rest days, and that was wrong often enough to matter: a
   * non-driving day is usually a day you go DO the thing you drove here for.
   * Calling it rest framed the point of the trip as the gap between drives.
   * "Base" says what is actually true on every one of them — you have a base
   * and you are working out of it — without promising an adventure on the days
   * that are really laundry and a rained-out afternoon.
   *
   * The DB column keeps `'rest'`. Renaming an enum across the schema, Penny's
   * tools and 148 references buys nothing the label does not.
   */
  const baseDayColor = '#6BA368';
  const driveColor = leg.color || '#4E7AB0';
  const dotColor = isRestDay ? baseDayColor : driveColor;

  return (
    <div
      data-testid="leg-card"
      data-leg-id={leg.id}
      data-leg-type={leg.leg_type ?? 'drive'}
      style={{
        marginBottom: 2,
        background: expanded
          ? isRestDay
            ? 'rgba(107, 163, 104, 0.06)'
            : 'var(--tp-surface-muted)'
          : 'transparent',
        borderRadius: 8,
        overflow: 'hidden',
        transition: 'background 0.2s',
        borderLeft: isRestDay ? `3px solid ${baseDayColor}40` : 'none',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 16px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: isRestDay ? 3 : '50%',
            background: dotColor,
            flexShrink: 0,
            boxShadow: `0 0 8px ${dotColor}40`,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            {isRestDay && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: baseDayColor,
                }}
              >
                BASE
              </span>
            )}
            {dateLabel ? (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: isRestDay ? baseDayColor : 'var(--tp-subtle)',
                }}
              >
                {dateLabel.toUpperCase()}
              </span>
            ) : !isRestDay && leg.label ? (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: 'var(--tp-subtle)',
                }}
              >
                {leg.label}
              </span>
            ) : null}
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--tp-text)' }}>{leg.title}</span>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 3, flexWrap: 'wrap' }}>
            {!isRestDay && leg.distance_km ? (
              <Distance
                km={leg.distance_km}
                layout="inline"
                style={{ fontSize: 12, color: 'var(--tp-subtle)' }}
              />
            ) : null}
            {!isRestDay && driveHours ? (
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--tp-subtle)',
                }}
              >
                {driveHours} hrs
              </span>
            ) : null}
            {isRestDay && leg.end_name && (
              <span style={{ fontSize: 12, color: baseDayColor }}>
                {leg.end_name}
              </span>
            )}
          </div>
          {leg.continuity_warning && (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                marginTop: 6,
                padding: '6px 8px',
                borderRadius: 6,
                background: 'rgba(217, 119, 6, 0.12)',
                border: '1px solid rgba(217, 119, 6, 0.35)',
                fontSize: 12,
                lineHeight: 1.4,
                color: 'var(--tp-text)',
              }}
            >
              <span aria-hidden style={{ color: '#d97706', flexShrink: 0 }}>
                ⚠
              </span>
              <span>{leg.continuity_warning}</span>
            </div>
          )}
        </div>
        <StatusBadge status={leg.status} />
        <span
          style={{
            color: 'var(--tp-subtle)',
            fontSize: 18,
            transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
            transition: 'transform 0.2s',
          }}
        >
          ▾
        </span>
      </div>

      {expanded && isRestDay && (
        <div style={{ padding: '0 16px 16px 40px' }}>
          {/* Location */}
          <div style={{ display: 'flex', gap: 24, marginBottom: 10, flexWrap: 'wrap' }}>
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: baseDayColor,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  marginBottom: 2,
                }}
              >
                LOCATION
              </div>
              <div style={{ fontSize: 13, color: 'var(--tp-muted)' }}>
                {leg.end_name || leg.overnight || '—'}
              </div>
            </div>
          </div>

          {/* Notes */}
          {leg.parsedNotes.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div
                style={{
                  fontSize: 10,
                  color: baseDayColor,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  marginBottom: 6,
                }}
              >
                PLANS & NOTES
              </div>
              {leg.parsedNotes.map((note: string, i: number) => (
                <div
                  key={i}
                  style={{
                    fontSize: 13,
                    color: 'var(--tp-muted)',
                    lineHeight: 1.5,
                    padding: '3px 0 3px 12px',
                    borderLeft: `2px solid ${baseDayColor}40`,
                    marginBottom: 2,
                  }}
                >
                  {note}
                </div>
              ))}
            </div>
          )}

          {/* Add to this day button — links to Penny chat */}
          {!readonly && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                // Dispatch a custom event that ChatPanel listens for to
                // pre-fill Penny's input with context about this rest day.
                const detail = {
                  legId: leg.id,
                  dayTitle: leg.title,
                  location: leg.end_name || leg.overnight || '',
                  dates: leg.dates,
                };
                window.dispatchEvent(
                  new CustomEvent('penny:prefill', { detail })
                );
              }}
              style={{
                marginTop: 14,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.04em',
                color: baseDayColor,
                background: `${baseDayColor}12`,
                border: `1px solid ${baseDayColor}30`,
                padding: '7px 14px',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              + Add to this day
            </button>
          )}
        </div>
      )}

      {expanded && !isRestDay && (
        <div style={{ padding: '0 16px 16px 40px' }}>
          <div style={{ marginTop: 8 }}>
            {leg.parsedNotes.map((note: string, i: number) => (
              <div
                key={i}
                style={{
                  fontSize: 13,
                  color: 'var(--tp-muted)',
                  lineHeight: 1.5,
                  padding: '3px 0 3px 12px',
                  borderLeft: '2px solid var(--tp-border)',
                  marginBottom: 2,
                }}
              >
                {note}
              </div>
            ))}
          </div>

          {allSegments.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {isFuelSyncing ? (
                /* Syncing state — placeholder while fuel stops refresh */
                <a
                  href={directionsUrl ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  aria-busy="true"
                  title={
                    fuelSyncTotalLegs && fuelSyncTotalLegs > 0
                      ? `Refreshing fuel stops across ${fuelSyncTotalLegs} leg${
                          fuelSyncTotalLegs === 1 ? '' : 's'
                        } — links will update in a moment.`
                      : 'Refreshing fuel stops — links will update in a moment.'
                  }
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    color: 'var(--tp-muted)',
                    background: 'var(--tp-surface-muted)',
                    border: '1px dashed var(--tp-border-strong)',
                    padding: '6px 13px',
                    borderRadius: 6,
                    textDecoration: 'none',
                  }}
                >
                  <Spinner size={12} thickness={2} color="var(--tp-gold)" />
                  <span>Updating route…</span>
                </a>
              ) : (
                /* ONE list, always.
                   There is deliberately no "collapse to a single button" branch
                   here any more. GPS decides the ORDER (`isNext` floats to the
                   top); it never decides the CONTENTS. Whatever else is on
                   screen, the driver can always see where the day ends. */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      color: 'var(--tp-subtle)',
                      marginBottom: 2,
                    }}
                  >
                    {gpsStatus === 'pending'
                      ? 'FINDING YOUR LOCATION\u2026'
                      : `NAVIGATE (${navButtons.length} STOP${navButtons.length === 1 ? '' : 'S'})`}
                  </div>
                  {navButtons.map((seg, i) => (
                    <a
                      key={`${seg.stopType ?? 'stop'}-${seg.url}`}
                      href={seg.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      data-testid="nav-stop-link"
                      data-nav-stop-type={seg.stopType ?? 'other'}
                      data-nav-next={seg.isNext ? 'true' : undefined}
                      title={navButtonLabel(seg)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        color: '#000',
                        background: 'var(--tp-primary)',
                        padding: seg.isNext ? '7px 14px' : '6px 12px',
                        borderRadius: 6,
                        textDecoration: 'none',
                        boxShadow: seg.isNext
                          ? '0 2px 8px rgba(124,181,232,0.2)'
                          : '0 2px 8px rgba(124,181,232,0.15)',
                        opacity: !seg.isNext && i > 0 && navButtons[0].isNext ? 0.82 : 1,
                        width: 'fit-content',
                      }}
                    >
                      <span>\u25b6</span>
                      {navButtonLabel(seg)}
                      {seg.isNext ? (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 800,
                            letterSpacing: '0.1em',
                            background: 'rgba(0,0,0,0.18)',
                            borderRadius: 3,
                            padding: '1px 5px',
                          }}
                        >
                          NEXT
                        </span>
                      ) : null}
                    </a>
                  ))}
                </div>
              )}
              {driveHours ? (
                <p
                  style={{
                    fontSize: 11,
                    color: 'var(--tp-subtle)',
                    margin: '8px 0 0 0',
                    maxWidth: 460,
                    lineHeight: 1.45,
                  }}
                >
                  {navWaypointCount > 0 ? (
                    <>
                      Shown driving time (~{driveHours} h) is the leg headline start→destination only — it excludes
                      detours via added stops.
                    </>
                  ) : (
                    <>
                      Shown driving time (~{driveHours} h) assumes start→destination without intermediate stops inside
                      this leg card.
                    </>
                  )}
                </p>
              ) : null}
            </div>
          )}

          <StopsSection
            tripId={tripId}
            legId={leg.id}
            legEndName={leg.end_name}
            legEndCoords={{ lat: leg.end_lat, lng: leg.end_lng }}
            legStartCoords={{ lat: leg.start_lat, lng: leg.start_lng }}
            initialStops={leg.stops}
            fuelStatus={leg.fuel_status}
            fuelPlanError={leg.fuel_plan_error}
            fuelLoading={fuelLoading}
            isPast={isPast}
            onChanged={onChanged}
            readonly={readonly}
            highlightStopId={highlightStopId}
          />

          {itemCosts.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: '10px 14px',
                background: 'var(--tp-surface-muted)',
                borderRadius: 6,
                border: '1px solid var(--tp-border)',
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'var(--tp-subtle)',
                  marginBottom: 6,
                  
                }}
              >
                ESTIMATED COSTS
              </div>
              {itemCosts.map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 13,
                    color: 'var(--tp-muted)',
                    padding: '2px 0',
                    
                  }}
                >
                  <span>{c.item}</span>
                  <span style={{ color: 'var(--tp-text)' }}>{c.estimate}</span>
                </div>
              ))}
              {totalCost && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 14,
                    fontWeight: 700,
                    color: 'var(--tp-text)',
                    padding: '6px 0 0',
                    borderTop: '1px solid var(--tp-border)',
                    marginTop: 4,
                    
                  }}
                >
                  <span>{totalCost.item}</span>
                  <span>{totalCost.estimate}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
