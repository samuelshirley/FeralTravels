'use client';

import { useEffect, useMemo, useState } from 'react';
import type { RouteWithLinks } from '@/types/trip';
import { tripApi } from '@/lib/api';

interface RoutesSectionProps {
  tripId: number;
  legId: number;
  initialRoutes: RouteWithLinks[];
  onChanged?: () => void;
  readonly?: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
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

export default function RoutesSection({
  tripId,
  legId,
  initialRoutes,
  onChanged,
  readonly = false,
}: RoutesSectionProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const [routes, setRoutes] = useState<RouteWithLinks[]>(initialRoutes);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');

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
      prev.map((r) => ({
        ...r,
        status: r.id === id ? 'selected' : r.status === 'selected' ? 'option' : r.status,
      }))
    );
    try {
      await api.selectRoute(id);
      reload();
    } catch {
      reload();
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
          readonly={readonly}
          onDelete={() => handleDeleteRoute(route.id)}
          onSelect={() => handleSelectRoute(route.id)}
        />
      ))}
    </div>
  );
}

interface RouteRowProps {
  route: RouteWithLinks;
  readonly?: boolean;
  onDelete: () => void;
  onSelect: () => void;
}

/**
 * A single route option — title, description, a radio dot, and nothing else.
 *
 * The whole card is a click target: clicking anywhere selects this route as
 * tonight's pick. The leg-level "Open in Google Maps" button (in LegCard)
 * reads the selected route and builds the nav URL from its end-coords plus
 * any selected stops, so we don't need per-route nav/GPX/link pills here.
 */
function RouteRow({ route, readonly = false, onDelete, onSelect }: RouteRowProps) {
  const isSelected = route.status === 'selected';
  const driveTimeLabel = formatDriveTime(route.drive_time_minutes);
  const sourceLabel = route.end_source ? SOURCE_LABELS[route.end_source] : null;
  const clickable = !readonly && !isSelected;

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={isSelected}
      onClick={clickable ? onSelect : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      style={{
        padding: '8px 10px',
        background: isSelected ? 'rgba(124,232,163,0.08)' : 'rgba(0,0,0,0.2)',
        borderRadius: 5,
        border: isSelected
          ? '1px solid rgba(124,232,163,0.45)'
          : '1px solid rgba(255,255,255,0.05)',
        marginTop: 6,
        cursor: clickable ? 'pointer' : 'default',
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
            {/* Provenance pill — e.g. "Google Places ↗" — lets the user open
                the source page this overnight option was pulled from. It's
                informational, not a nav link, and is intentionally kept after
                the main card body was stripped down. */}
            {route.end_source_url && (
              <div style={{ marginTop: 6 }}>
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
              </div>
            )}
          </div>
        </div>
        {!readonly && (
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
              flexShrink: 0,
            }}
            title="Delete route"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
