'use client';

import { useEffect, useRef, useState } from 'react';
import type { RouteWithLinks, RouteLinkType } from '@/types/trip';
import { tripApi } from '@/lib/api';

interface RoutesSectionProps {
  tripId: number;
  legId: number;
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
  { id: 'other', label: 'Link', icon: '↗' },
];

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
  initialRoutes,
  onChanged,
  onTrailsChanged,
  readonly = false,
}: RoutesSectionProps) {
  const api = tripApi(tripId);
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
          readonly={readonly}
          linkPopoverOpen={linkPopoverFor === route.id}
          onToggleLinkPopover={() =>
            setLinkPopoverFor(linkPopoverFor === route.id ? null : route.id)
          }
          onDelete={() => handleDeleteRoute(route.id)}
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
  readonly?: boolean;
  linkPopoverOpen: boolean;
  onToggleLinkPopover: () => void;
  onDelete: () => void;
  onAddLink: (url: string, type: RouteLinkType, label: string) => void;
  onDeleteLink: (linkId: number) => void;
  onGpxDrop: (file: File) => void;
}

function RouteRow({
  route,
  readonly = false,
  linkPopoverOpen,
  onToggleLinkPopover,
  onDelete,
  onAddLink,
  onDeleteLink,
  onGpxDrop,
}: RouteRowProps) {
  const [url, setUrl] = useState('');
  const [type, setType] = useState<RouteLinkType>('google_maps');
  const [label, setLabel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

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
        background: 'rgba(0,0,0,0.2)',
        borderRadius: 5,
        border: '1px solid rgba(255,255,255,0.05)',
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: 13,
                color: 'rgba(255,255,255,0.85)',
                fontWeight: 500,
              }}
            >
              {route.label}
            </span>
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
            }}
            title="Delete route"
          >
            ×
          </button>
        )}
      </div>

      {/* Link pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
        {route.links.map((link) => (
          <a
            key={link.id}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
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
            <span style={{ fontSize: 10 }}>{linkIcon(link.type)}</span>
            {link.label}
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
        ))}
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
