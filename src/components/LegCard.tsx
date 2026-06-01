'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LegWithDetails } from '@/types/trip';
import { tripApi } from '@/lib/api';
import { buildLegDirectionsUrl, buildSegmentedNavUrls, legDirectionsWaypoints } from '@/lib/maps';
import { useNextStop } from '@/lib/useNextStop';
import StatusBadge from './StatusBadge';
import Spinner from './Spinner';
import StopsSection from './StopsSection';
import Distance from './Distance';

/** Format a stop type slug into a readable label for nav buttons. */
function formatStopType(stopType?: string): string {
  switch (stopType) {
    case 'fuel': return 'Fuel';
    case 'dump_station': return 'Dump Station';
    case 'food': return 'Food';
    case 'overnight': return 'Overnight';
    case 'rest': return 'Rest';
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
}

interface AttachedTrail {
  id: string;
  name: string;
  source: string | null;
  source_url: string | null;
  surface: string | null;
  distance_km: number | null;
}

export default function LegCard({
  tripId,
  leg,
  expanded,
  onToggle,
  onNavigate,
  onTrailsChanged,
  onChanged,
  readonly = false,
  dateLabel,
  isFuelSyncing = false,
  fuelSyncTotalLegs,
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
  // Show the smart single button when GPS is active and user is near the route.
  const showSmartNav = gpsStatus === 'active' && isNearRoute && nextStop != null;

  const [trails, setTrails] = useState<AttachedTrail[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadTrails = async () => {
    try {
      const data = await api.listGpxForLeg(leg.id);
      if (Array.isArray(data)) {
        setTrails(
          (data as any[]).map((t) => ({
            id: t.id,
            name: t.name,
            source: t.source,
            source_url: t.source_url,
            surface: t.surface,
            distance_km: t.distance_km,
          }))
        );
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (expanded) loadTrails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, leg.id]);

  const handleUpload = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    try {
      await api.uploadGpx(leg.id, file, file.name.replace(/\.gpx$/i, ''));
      await loadTrails();
      onTrailsChanged?.();
    } catch (err: any) {
      setUploadError(err?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteTrail = async (trailId: string) => {
    try {
      await api.deleteGpx(trailId);
      await loadTrails();
      onTrailsChanged?.();
    } catch {
      /* ignore */
    }
  };

  // Rest day accent color — softer green vs driving day blue
  const restDayColor = '#6BA368';
  const driveColor = leg.color || '#4E7AB0';
  const dotColor = isRestDay ? restDayColor : driveColor;

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
        borderLeft: isRestDay ? `3px solid ${restDayColor}40` : 'none',
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
                  color: restDayColor,
                }}
              >
                REST
              </span>
            )}
            {dateLabel ? (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  color: isRestDay ? restDayColor : 'var(--tp-subtle)',
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
              <span style={{ fontSize: 12, color: restDayColor }}>
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
                  color: restDayColor,
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
                  color: restDayColor,
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
                    borderLeft: `2px solid ${restDayColor}40`,
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
                color: restDayColor,
                background: `${restDayColor}12`,
                border: `1px solid ${restDayColor}30`,
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
          <div style={{ display: 'flex', gap: 24, marginBottom: 10, flexWrap: 'wrap' }}>
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--tp-subtle)',
                  marginBottom: 2,
                }}
              >
                TERRAIN
              </div>
              <div style={{ fontSize: 13, color: 'var(--tp-muted)' }}>{leg.terrain}</div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--tp-subtle)',
                  marginBottom: 2,
                }}
              >
                OVERNIGHT
              </div>
              <div style={{ fontSize: 13, color: 'var(--tp-muted)' }}>{leg.overnight}</div>
            </div>
          </div>

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
              ) : showSmartNav ? (
                /* GPS-aware: single button to next stop */
                <a
                  href={nextStop!.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  data-testid="nav-next-stop"
                  title={navButtonLabel(nextStop!)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    color: '#000',
                    background: 'var(--tp-primary)',
                    padding: '7px 14px',
                    borderRadius: 6,
                    textDecoration: 'none',
                    boxShadow: '0 2px 8px rgba(124,181,232,0.2)',
                  }}
                >
                  <span>▶</span>
                  {navButtonLabel(nextStop!)}
                </a>
              ) : (
                /* Fallback: full list of stop buttons (no GPS / far from route / planning) */
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
                      ? 'FINDING YOUR LOCATION…'
                      : `NAVIGATE (${allSegments.length} STOP${allSegments.length === 1 ? '' : 'S'})`}
                  </div>
                  {allSegments.map((seg, i) => (
                    <a
                      key={i}
                      href={seg.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      data-testid="nav-stop-link"
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
                        padding: '6px 12px',
                        borderRadius: 6,
                        textDecoration: 'none',
                        boxShadow: '0 2px 8px rgba(124,181,232,0.15)',
                        width: 'fit-content',
                      }}
                    >
                      <span>▶</span>
                      {navButtonLabel(seg)}
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
            onChanged={onChanged}
            readonly={readonly}
          />

          <div
            style={{
              marginTop: 12,
              padding: '10px 14px',
              background: 'var(--tp-surface-muted)',
              borderRadius: 6,
              border: '1px solid var(--tp-border)',
            }}
            onDragOver={(e) => {
              if (readonly) return;
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              if (readonly) return;
              e.preventDefault();
              e.stopPropagation();
              const f = Array.from(e.dataTransfer.files).find((file) =>
                file.name.toLowerCase().endsWith('.gpx')
              );
              if (f) handleUpload(f);
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  color: 'var(--tp-subtle)',
                  
                }}
              >
                TRAILS / GPX
              </div>
              {!readonly && (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".gpx,application/gpx+xml,application/xml,text/xml"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f);
                      e.target.value = '';
                    }}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    disabled={uploading}
                    style={{
                      fontSize: 11,
                      background: 'rgba(124,181,232,0.15)',
                      border: '1px solid rgba(124,181,232,0.3)',
                      color: 'var(--tp-primary)',
                      padding: '3px 10px',
                      borderRadius: 4,
                      cursor: uploading ? 'default' : 'pointer',
                      
                    }}
                  >
                    {uploading ? 'Uploading…' : '+ Add GPX'}
                  </button>
                </div>
              )}
            </div>

            {trails.length === 0 && !uploadError && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--tp-subtle)',
                  
                }}
              >
                {readonly
                  ? 'No trails for this leg.'
                  : 'Drop a .gpx file here, or click + Add GPX. (Wikiloc, TET, Komoot, Gaia exports.)'}
              </div>
            )}

            {uploadError && (
              <div style={{ fontSize: 11, color: 'var(--tp-danger)', marginBottom: 6 }}>{uploadError}</div>
            )}

            {trails.map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '4px 0',
                  fontSize: 12,
                  color: 'var(--tp-muted)',
                  borderTop: '1px solid var(--tp-border)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.name}
                    </span>
                    {t.distance_km != null && (
                      <Distance
                        km={t.distance_km}
                        layout="inline"
                        style={{ fontSize: 10, color: 'var(--tp-muted)' }}
                      />
                    )}
                  </div>
                  {(t.source || t.source_url) && (
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--tp-subtle)',
                        
                      }}
                    >
                      {t.source_url ? (
                        <a
                          href={t.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
                        >
                          {t.source || 'source'} →
                        </a>
                      ) : (
                        t.source
                      )}
                    </div>
                  )}
                </div>
                {!readonly && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteTrail(t.id);
                    }}
                    style={{
                      fontSize: 11,
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--tp-muted)',
                      cursor: 'pointer',
                      padding: '2px 6px',
                    }}
                    title="Remove trail"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

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
