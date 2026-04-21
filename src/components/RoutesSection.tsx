'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RouteWithLinks, RouteLinkType } from '@/types/trip';
import { tripApi } from '@/lib/api';
import { rewriteMapsUrlForNav, type LegCoords } from '@/lib/maps';

interface RoutesSectionProps {
  tripId: number;
  legId: number;
  legCoords: LegCoords;
  initialRoutes: RouteWithLinks[];
  onChanged?: () => void;
  onTrailsChanged?: () => void;
  readonly?: boolean;
}

const LINK_TYPES: { id: RouteLinkType; label: string; icon: string }[] = [
  { id: 'google_maps', label: 'Google Maps', icon: '◎' },
  { id: 'gpx', label: 'GPX', icon: '⛰' },
  { id: 'wikiloc', label: 'Wikiloc', icon: '⛰' },
  { id: 'komoot', label: 'Komoot', icon: '⛰' },
  { id: 'gaia', label: 'Gaia', icon: '⛰' },
  { id: 'park4night', label: 'Park4Night', icon: '⌂' },
  { id: 'ioverlander', label: 'iOverlander', icon: '⌂' },
  { id: 'dog_park', label: 'Dog park', icon: '✦' },
  { id: 'other', label: 'Link', icon: '↗' },
];

const SOURCE_LABELS: Record<string, string> = {
  ioverlander: 'iOverlander',
  park4night: 'Park4Night',
  google_places: 'Google Places',
  manual: 'Manual',
};

function formatDriveTime(minutes: number | null | undefined): string | null {
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

const SURFACE_COLORS: Record<string, { bg: string; fg: string }> = {
  paved: { bg: 'rgba(124,181,232,0.15)', fg: '#7CB5E8' },
  gravel: { bg: 'rgba(232,213,124,0.15)', fg: '#E8D57C' },
  mix: { bg: 'rgba(232,146,124,0.15)', fg: '#E8927C' },
};

function surfaceChip(surface: string | null) {
  if (!surface) return null;
  const key = surface.toLowerCase();
  const c = SURFACE_COLORS[key] || { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.5)' };
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        background: c.bg,
        color: c.fg,
        padding: '2px 6px',
        borderRadius: 3,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {surface}
    </span>
  );
}

function linkIcon(type: string) {
  const t = LINK_TYPES.find((x) => x.id === type);
  return t?.icon || '↗';
}

export default function RoutesSection({
  tripId,
  legId,
  legCoords,
  initialRoutes,
  onChanged,
  onTrailsChanged,
  readonly = false,
}: RoutesSectionProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const [routes, setRoutes] = useState<RouteWithLinks[]>(initialRoutes);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [linkPopoverFor, setLinkPopoverFor] = useState<number | null>(null);

  useEffect(() => {
    setRoutes(initialRoutes);
  }, [initialRoutes]);

  async function reload() {
    try {
      const data = await api.listRoutes(legId);
      if (Array.isArray(data)) setRoutes(data as RouteWithLinks[]);
      onChanged?.();
    } catch {
      /* ignore */
    }
  }

  async function handleAddRoute() {
    const label = newLabel.trim();
    if (!label) return;
    try {
      await api.addRoute(legId, { label });
      setNewLabel('');
      setAdding(false);
      reload();
    } catch {
      /* ignore */
    }
  }

  async function handleDeleteRoute(id: number) {
    if (!confirm('Delete this route option?')) return;
    try {
      await api.deleteRoute(id);
      reload();
    } catch {
      /* ignore */
    }
  }

  async function handleSelectRoute(id: number) {
    // Optimistic: flip status locally so the radio dot moves immediately,
    // then reconcile with server response.
    setRoutes((prev) =>
      prev.map((r) => ({ ...r, status: r.id === id ? 'selected' : r.status === 'selected' ? 'option' : r.status }))
    );
    try {
      await api.selectRoute(id);
      reload();
    } catch {
      reload();
    }
  }

  async function handleAddLink(routeId: number, url: string, type: RouteLinkType, label: string) {
    if (!url.trim()) return;
    try {
      await api.addRouteLink(routeId, { url: url.trim(), type, label: label.trim() || undefined });
      setLinkPopoverFor(null);
      reload();
    } catch {
      /* ignore */
    }
  }

  async function handleDeleteLink(routeId: number, linkId: number) {
    try {
      await api.deleteRouteLink(routeId, linkId);
      reload();
    } catch {
      /* ignore */
    }
  }

  async function handleGpxDrop(routeId: number, file: File) {
    try {
      const trail = (await api.uploadGpx(legId, file, file.name.replace(/\.gpx$/i, ''))) as { id?: number };
      if (trail?.id) {
        await api.updateRoute(routeId, { gpx_trail_id: trail.id });
      }
      reload();
      onTrailsChanged?.();
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: '10px 14px',
        background: 'rgba(255,255,255,0.03)',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.06)',
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
            color: 'rgba(255,255,255,0.35)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          ROUTES
        </div>
        {!readonly && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAdding((v) => !v);
            }}
            style={{
              fontSize: 11,
              background: 'rgba(124,181,232,0.15)',
              border: '1px solid rgba(124,181,232,0.3)',
              color: '#7CB5E8',
              padding: '3px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            + Add Route
          </button>
        )}
      </div>

      {adding && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input
            autoFocus
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddRoute();
              if (e.key === 'Escape') setAdding(false);
            }}
            placeholder="Route A: ... → ..."
            style={{
              flex: 1,
              padding: '6px 10px',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 4,
              color: '#fff',
              fontSize: 12,
              outline: 'none',
            }}
          />
          <button
            onClick={handleAddRoute}
            style={{
              fontSize: 11,
              background: '#7CB5E8',
              border: 'none',
              color: '#000',
              padding: '6px 12px',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Add
          </button>
        </div>
      )}

      {routes.length === 0 && !adding && (
        <div
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          No route options yet. Ask Penny or add one manually.
        </div>
      )}

      {routes.map((route) => (
        <RouteRow
          key={route.id}
          route={route}
          legId={legId}
          legCoords={legCoords}
          readonly={readonly}
          linkPopoverOpen={linkPopoverFor === route.id}
          onToggleLinkPopover={() =>
            setLinkPopoverFor(linkPopoverFor === route.id ? null : route.id)
          }
          onDelete={() => handleDeleteRoute(route.id)}
          onSelect={() => handleSelectRoute(route.id)}
          onAddLink={(url, type, label) => handleAddLink(route.id, url, type, label)}
          onDeleteLink={(linkId) => handleDeleteLink(route.id, linkId)}
          onGpxDrop={(file) => handleGpxDrop(route.id, file)}
        />
      ))}
    </div>
  );
}

interface RouteRowProps {
  route: RouteWithLinks;
  legId: number;
  legCoords: LegCoords;
  readonly?: boolean;
  linkPopoverOpen: boolean;
  onToggleLinkPopover: () => void;
  onDelete: () => void;
  onSelect: () => void;
  onAddLink: (url: string, type: RouteLinkType, label: string) => void;
  onDeleteLink: (linkId: number) => void;
  onGpxDrop: (file: File) => void;
}

function RouteRow({
  route,
  legCoords,
  readonly = false,
  linkPopoverOpen,
  onToggleLinkPopover,
  onDelete,
  onSelect,
  onAddLink,
  onDeleteLink,
  onGpxDrop,
}: RouteRowProps) {
  const [url, setUrl] = useState('');
  const [type, setType] = useState<RouteLinkType>('google_maps');
  const [label, setLabel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // When a route has its own end coords (e.g. an overnight option from
  // iOverlander), any route-level Google Maps pill should target that spot
  // — not the leg's default destination.
  const effectiveCoords: LegCoords =
    route.end_lat != null && route.end_lng != null
      ? {
          start_lat: legCoords.start_lat,
          start_lng: legCoords.start_lng,
          end_lat: route.end_lat,
          end_lng: route.end_lng,
        }
      : legCoords;

  const isSelected = route.status === 'selected';
  const driveTimeLabel = formatDriveTime(route.drive_time_minutes);
  const sourceLabel = route.end_source ? SOURCE_LABELS[route.end_source] : null;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const f = Array.from(e.dataTransfer.files).find((file) =>
          file.name.toLowerCase().endsWith('.gpx')
        );
        if (f) onGpxDrop(f);
      }}
      style={{
        padding: '8px 10px',
        background: isSelected ? 'rgba(124,232,163,0.08)' : 'rgba(0,0,0,0.2)',
        borderRadius: 5,
        border: isSelected
          ? '1px solid rgba(124,232,163,0.45)'
          : '1px solid rgba(255,255,255,0.05)',
        marginTop: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          {!readonly ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!isSelected) onSelect();
              }}
              aria-pressed={isSelected}
              title={isSelected ? "Tonight's pick" : 'Pick this route as tonight\u2019s stop'}
              style={{
                marginTop: 2,
                width: 16,
                height: 16,
                borderRadius: 999,
                border: isSelected
                  ? '4px solid #7CE8A3'
                  : '1px solid rgba(255,255,255,0.4)',
                background: isSelected ? '#7CE8A3' : 'transparent',
                cursor: isSelected ? 'default' : 'pointer',
                flexShrink: 0,
                padding: 0,
              }}
            />
          ) : (
            <span
              style={{
                marginTop: 2,
                width: 16,
                height: 16,
                borderRadius: 999,
                border: isSelected
                  ? '4px solid #7CE8A3'
                  : '1px solid rgba(255,255,255,0.4)',
                background: isSelected ? '#7CE8A3' : 'transparent',
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: 13,
                  color: isSelected ? '#7CE8A3' : 'rgba(255,255,255,0.85)',
                  fontWeight: isSelected ? 600 : 500,
                }}
              >
                {route.label}
              </span>
              {driveTimeLabel && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    background: 'rgba(124,181,232,0.15)',
                    color: '#7CB5E8',
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                  title="Estimated drive time from leg start"
                >
                  {driveTimeLabel}
                </span>
              )}
              {sourceLabel && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    background: 'rgba(232,213,124,0.12)',
                    color: '#E8D57C',
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {sourceLabel}
                </span>
              )}
              {surfaceChip(route.surface)}
              {route.distance_km != null && (
                <span
                  style={{
                    fontSize: 10,
                    color: 'rgba(255,255,255,0.4)',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {route.distance_km} km
                </span>
              )}
            </div>
            {route.end_name && (
              <div
                style={{
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.55)',
                  marginTop: 3,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                → {route.end_name}
              </div>
            )}
            {route.description && (
              <div
                style={{
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.5)',
                  marginTop: 4,
                  lineHeight: 1.4,
                }}
              >
                {route.description}
              </div>
            )}
          </div>
        </div>
        {!readonly && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {!isSelected && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect();
                }}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  background: 'rgba(124,232,163,0.12)',
                  border: '1px solid rgba(124,232,163,0.35)',
                  color: '#7CE8A3',
                  padding: '3px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                  textTransform: 'uppercase',
                }}
                title="Pick this route as tonight\u2019s stop"
              >
                Pick this
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              style={{
                fontSize: 12,
                background: 'transparent',
                border: 'none',
                color: 'rgba(255,255,255,0.35)',
                cursor: 'pointer',
                padding: '2px 6px',
              }}
              title="Delete route"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* Link pills — note: per-route "Go" button was removed in favor of a
          single unified "Open in Google Maps" button at the leg level that
          composes the selected route's end override with any selected stops
          as waypoints. See LegCard → buildLegDirectionsUrl. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
        {/* Source link pill — gives the user the original iOverlander/P4N page */}
        {route.end_source_url && !route.links.some((l) => l.url === route.end_source_url) && (
          <a
            href={route.end_source_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`Open ${sourceLabel || 'source'} page`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: '#E8D57C',
              textDecoration: 'none',
              padding: '3px 8px',
              border: '1px solid rgba(232,213,124,0.3)',
              borderRadius: 12,
              background: 'rgba(232,213,124,0.08)',
            }}
          >
            <span style={{ fontSize: 10 }}>↗</span>
            {sourceLabel || 'Source'}
          </a>
        )}
        {route.links.map((link) => {
          // For Google Maps links, rewrite to launch turn-by-turn navigation
          // mode (using leg coords if the original is a preview/place URL).
          const href =
            link.type === 'google_maps'
              ? rewriteMapsUrlForNav(link.url, effectiveCoords)
              : link.url;
          const isNav = link.type === 'google_maps' && href !== link.url;
          return (
          <a
            key={link.id}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={
              link.type === 'google_maps'
                ? 'Open in Google Maps and start navigation'
                : link.url
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: '#7CB5E8',
              textDecoration: 'none',
              padding: '3px 8px',
              border: '1px solid rgba(124,181,232,0.3)',
              borderRadius: 12,
              background: 'rgba(124,181,232,0.08)',
            }}
          >
            <span style={{ fontSize: 10 }}>
              {link.type === 'google_maps' ? '▶' : linkIcon(link.type)}
            </span>
            {link.type === 'google_maps' ? (isNav ? 'Go' : link.label) : link.label}
            {!readonly && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDeleteLink(link.id);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'rgba(255,255,255,0.4)',
                  fontSize: 11,
                  cursor: 'pointer',
                  padding: 0,
                  marginLeft: 2,
                  lineHeight: 1,
                }}
                title="Remove link"
              >
                ×
              </button>
            )}
          </a>
          );
        })}
        {!readonly && (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleLinkPopover();
              }}
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.5)',
                background: 'transparent',
                border: '1px dashed rgba(255,255,255,0.15)',
                padding: '3px 8px',
                borderRadius: 12,
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              + link
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".gpx,application/gpx+xml,application/xml,text/xml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onGpxDrop(f);
                e.target.value = '';
              }}
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                fileRef.current?.click();
              }}
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.5)',
                background: 'transparent',
                border: '1px dashed rgba(255,255,255,0.15)',
                padding: '3px 8px',
                borderRadius: 12,
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
              }}
              title="Attach a .gpx file (or drop one onto this route)"
            >
              ⛰ + GPX
            </button>
          </>
        )}
      </div>

      {!readonly && linkPopoverOpen && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 5,
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <select
            value={type}
            onChange={(e) => setType(e.target.value as RouteLinkType)}
            style={{
              padding: '5px 8px',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 4,
              color: '#fff',
              fontSize: 11,
              outline: 'none',
            }}
          >
            {LINK_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            style={{
              flex: 1,
              minWidth: 180,
              padding: '5px 8px',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 4,
              color: '#fff',
              fontSize: 11,
              outline: 'none',
            }}
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label (optional)"
            style={{
              width: 130,
              padding: '5px 8px',
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 4,
              color: '#fff',
              fontSize: 11,
              outline: 'none',
            }}
          />
          <button
            onClick={() => {
              const finalLabel = label.trim() || LINK_TYPES.find((t) => t.id === type)?.label || 'link';
              onAddLink(url, type, finalLabel);
              setUrl('');
              setLabel('');
            }}
            style={{
              fontSize: 11,
              background: '#7CB5E8',
              border: 'none',
              color: '#000',
              padding: '5px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
