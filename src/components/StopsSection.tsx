'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FuelStatus, Stop, StopType } from '@/types/trip';
import { tripApi, ApiError } from '@/lib/api';
import { buildDogParkSearchUrl, buildParkSearchUrl } from '@/lib/maps';
import { parseCoords, needsServerResolution } from '@/lib/coords';
import Spinner from './Spinner';

interface StopsSectionProps {
  tripId: number;
  legId: number;
  legEndName: string | null;
  legEndCoords: { lat: number | null; lng: number | null };
  legStartCoords?: { lat: number | null; lng: number | null };
  initialStops: Stop[];
  /**
   * Per-leg auto fuel lifecycle from the server (`computing` while trip-wide
   * replan runs).
   */
  fuelStatus?: FuelStatus;
  onChanged?: () => void;
  readonly?: boolean;
}

const TYPE_ORDER: StopType[] = ['fuel', 'water', 'food', 'overnight', 'rest', 'other'];

const TYPE_META: Record<StopType, { label: string; color: string; icon: string }> = {
  fuel: { label: 'Fuel', color: 'var(--tp-gold)', icon: '⛽' },
  water: { label: 'Water', color: 'var(--tp-primary)', icon: '💧' },
  food: { label: 'Food', color: 'var(--tp-accent-warm)', icon: '🍴' },
  overnight: { label: 'Overnight', color: '#8B7AB8', icon: '🌙' },
  rest: { label: 'Rest', color: 'var(--tp-success)', icon: '☕' },
  other: { label: 'Other', color: 'var(--tp-muted)', icon: '📍' },
};

export default function StopsSection({
  tripId,
  legId,
  legEndName,
  legEndCoords,
  legStartCoords: _legStartCoords,
  initialStops,
  fuelStatus = 'none',
  onChanged,
  readonly = false,
}: StopsSectionProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  void _legStartCoords;
  const [stops, setStops] = useState<Stop[]>(initialStops);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<StopType>('overnight');

  useEffect(() => {
    setStops(initialStops);
  }, [initialStops]);

  const fuelPlanning =
    fuelStatus === 'computing' || fuelStatus === 'pending';
  const hasEndCoords = legEndCoords.lat != null && legEndCoords.lng != null;
  // Overnight-spot discovery chips on the leg header point at the *leg end*
  // coords — that's where the user will be when they need to park for the
  // night. Individual overnight stops further down the list each get their
  // own chips centered on that stop's coords.
  const dogParkNearEnd = hasEndCoords
    ? buildDogParkSearchUrl(legEndCoords.lat as number, legEndCoords.lng as number)
    : null;
  const parkNearEnd = hasEndCoords
    ? buildParkSearchUrl(legEndCoords.lat as number, legEndCoords.lng as number)
    : null;
  // `legEndName` is kept in props for callers that might want to label
  // chips with the destination town in a future change; unused here for
  // now since the search term doesn't include it.
  void legEndName;

  async function reload() {
    try {
      const data = await api.listStopsForLeg(legId);
      if (Array.isArray(data)) setStops(data as Stop[]);
      onChanged?.();
    } catch {
      /* ignore */
    }
  }

  async function handleAddFromPaste() {
    const raw = pasteValue.trim();
    if (!raw) return;
    setPasteBusy(true);
    setPasteError(null);
    try {
      const parsed = parseCoords(raw);
      let coords = parsed;
      if (!coords && needsServerResolution(raw)) {
        coords = (await api.parseCoords(raw)) as typeof parsed;
      }
      if (!coords) {
        setPasteError(
          'Could not read coordinates from that — try decimal "lat, lng" or a Google Maps URL. (For iOverlander / Park4Night spots, copy the coords from their app and paste them here.)'
        );
        return;
      }
      await api.addStop(legId, {
        stop_type: addingType,
        name: coords.name || `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
        lat: coords.lat,
        lng: coords.lng,
        status: 'selected',
        source: coords.source ?? 'user',
        source_url: coords.source_url ?? null,
      });
      setPasteValue('');
      await reload();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to add stop';
      setPasteError(msg);
    } finally {
      setPasteBusy(false);
    }
  }

  async function handleSelect(id: number) {
    setStops((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: 'selected' } : s))
    );
    try {
      await api.selectStop(id);
      reload();
    } catch {
      reload();
    }
  }

  async function handleDismiss(id: number) {
    setStops((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: 'dismissed' } : s))
    );
    try {
      await api.updateStop(id, { status: 'dismissed' });
      reload();
    } catch {
      reload();
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this stop?')) return;
    try {
      await api.deleteStop(id);
      reload();
    } catch {
      /* ignore */
    }
  }

  const groups: Array<[StopType, Stop[]]> = TYPE_ORDER.map((t) => [
    t,
    stops.filter((s) => s.stop_type === t && s.status !== 'dismissed'),
  ]).filter(([, arr]) => arr.length > 0) as Array<[StopType, Stop[]]>;
  const dismissed = stops.filter((s) => s.status === 'dismissed');

  return (
    <div
      style={{
        marginTop: 12,
        padding: '10px 14px',
        background: 'var(--tp-surface-muted)',
        borderRadius: 6,
        border: '1px solid var(--tp-border)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: 'var(--tp-subtle)',
          marginBottom: 8,
        }}
      >
        STOPS
      </div>

      {!readonly && fuelPlanning && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <Spinner size={10} thickness={2} color="var(--tp-gold)" />
          <span
            style={{
              fontSize: 11,
              color: 'var(--tp-muted)',
            }}
          >
            Planning fuel stops…
          </span>
        </div>
      )}

      {!readonly && fuelStatus === 'failed' && (
        <div
          style={{
            marginBottom: 10,
            fontSize: 11,
            color: 'var(--tp-danger)',
            maxWidth: 420,
            lineHeight: 1.4,
          }}
        >
          Fuel planning failed for this leg. Check vehicle fuel economy and tank in Settings, and
          that the server has a Google Maps key with Places API enabled.
        </div>
      )}

      {hasEndCoords && dogParkNearEnd && parkNearEnd && !readonly && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <ExternalChip
            href={dogParkNearEnd}
            label="🐕 Dog parks nearby"
            hint="Open Google Maps centered on the leg end, searching for dog parks"
          />
          <ExternalChip
            href={parkNearEnd}
            label="🌳 Parks nearby"
            hint="Open Google Maps centered on the leg end, searching for parks"
          />
        </div>
      )}

      {!readonly && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginBottom: pasteError ? 4 : 10,
            flexWrap: 'wrap',
          }}
        >
          <select
            value={addingType}
            onChange={(e) => setAddingType(e.target.value as StopType)}
            style={{
              background: 'var(--tp-surface-muted)',
              border: '1px solid var(--tp-border)',
              borderRadius: 4,
              color: 'var(--tp-text)',
              fontSize: 11,
              padding: '6px 8px',
              
              outline: 'none',
            }}
          >
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {TYPE_META[t].icon} {TYPE_META[t].label}
              </option>
            ))}
          </select>
          <input
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddFromPaste();
            }}
            placeholder="Paste GPS (48.8566, 2.3522) or a Google Maps URL"
            disabled={pasteBusy}
            style={{
              flex: '1 1 280px',
              minWidth: 200,
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
            onClick={handleAddFromPaste}
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
      )}

      {pasteError && (
        <div style={{ fontSize: 11, color: 'var(--tp-danger)', marginBottom: 10 }}>{pasteError}</div>
      )}

      {groups.length === 0 && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--tp-subtle)',
            
          }}
        >
          {readonly
            ? 'No stops yet.'
            : hasEndCoords
              ? 'No stops yet. Tap the park search chips to find an overnight spot, then paste its coords here.'
              : 'No destination coords yet — add lat/lng to the leg to unlock park search chips.'}
        </div>
      )}

      {groups.map(([type, arr]) => (
        <StopGroup
          key={type}
          type={type}
          stops={arr}
          onSelect={handleSelect}
          onDismiss={handleDismiss}
          onDelete={handleDelete}
          readonly={readonly}
        />
      ))}

      {dismissed.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 10,
              
              color: 'var(--tp-muted)',
              letterSpacing: '0.08em',
            }}
          >
            {dismissed.length} DISMISSED
          </summary>
          <div style={{ marginTop: 6 }}>
            {dismissed.map((s) => (
              <StopRow
                key={s.id}
                stop={s}
                onSelect={handleSelect}
                onDismiss={handleDismiss}
                onDelete={handleDelete}
                readonly={readonly}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ExternalChip({ href, label, hint }: { href: string; label: string; hint?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={hint}
      style={{
        fontSize: 11,
        background: 'rgba(124,181,232,0.15)',
        border: '1px solid rgba(124,181,232,0.3)',
        color: 'var(--tp-primary)',
        padding: '4px 10px',
        borderRadius: 4,
        cursor: 'pointer',
        textDecoration: 'none',
        
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {label} ↗
    </a>
  );
}

function StopGroup({
  type,
  stops,
  onSelect,
  onDismiss,
  onDelete,
  readonly,
}: {
  type: StopType;
  stops: Stop[];
  onSelect: (id: number) => void;
  onDismiss: (id: number) => void;
  onDelete: (id: number) => void;
  readonly: boolean;
}) {
  const meta = TYPE_META[type];
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          fontSize: 10,
          
          color: meta.color,
          letterSpacing: '0.08em',
          marginBottom: 4,
        }}
      >
        {meta.icon} {meta.label.toUpperCase()}
      </div>
      {stops.map((s) => (
        <StopRow
          key={s.id}
          stop={s}
          onSelect={onSelect}
          onDismiss={onDismiss}
          onDelete={onDelete}
          readonly={readonly}
        />
      ))}
    </div>
  );
}

function StopRow({
  stop,
  onSelect,
  onDismiss,
  onDelete,
  readonly,
}: {
  stop: Stop;
  onSelect: (id: number) => void;
  onDismiss: (id: number) => void;
  onDelete: (id: number) => void;
  readonly: boolean;
}) {
  const selected = stop.status === 'selected';
  const dismissed = stop.status === 'dismissed';
  const hasCoords = stop.lat != null && stop.lng != null;
  const [copied, setCopied] = useState(false);

  // Reset the "Copied!" label after a short delay so repeated clicks work.
  async function handleCopyCoords() {
    if (!hasCoords) return;
    const text = `${stop.lat},${stop.lng}`;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older browsers — use a hidden textarea + execCommand.
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Swallow — permissions denied in some contexts. The user can still
      // read the coords from the stop name if they care.
    }
  }

  // Only overnight stops get the "park near this point" enrichment — fuel
  // and water stops are just utility stops, no park link adds value.
  const showParkChips = stop.stop_type === 'overnight' && hasCoords;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 0',
        fontSize: 12,
        color: dismissed ? 'var(--tp-subtle)' : 'var(--tp-text)',
        borderTop: '1px solid var(--tp-border)',
        opacity: dismissed ? 0.6 : 1,
      }}
    >
      {!readonly && !dismissed && (
        <button
          onClick={() => onSelect(stop.id)}
          title={selected ? 'Selected — included as a waypoint' : 'Select this stop'}
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: `1.5px solid ${selected ? 'var(--tp-success)' : 'var(--tp-border-strong)'}`,
            background: selected ? 'var(--tp-success)' : 'transparent',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
          }}
        />
      )}
      {(readonly || dismissed) && (
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: `1.5px solid ${selected ? 'var(--tp-success)' : 'var(--tp-border)'}`,
            background: selected ? 'var(--tp-success)' : 'transparent',
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span
            style={{
              fontWeight: selected ? 600 : 400,
              color: selected ? 'var(--tp-text)' : 'inherit',
              textDecoration: dismissed ? 'line-through' : 'none',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {stop.name}
          </span>
          {stop.distance_from_start_km != null && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--tp-muted)',
                
              }}
            >
              ~{stop.distance_from_start_km} km
            </span>
          )}
          {stop.fuel_type && (
            <span
              style={{
                fontSize: 10,
                color: 'var(--tp-muted)',
                
              }}
            >
              {stop.fuel_type}
            </span>
          )}
        </div>
        {(stop.notes || stop.source_url) && (
          <div
            style={{
              fontSize: 10,
              color: 'var(--tp-subtle)',
              
              marginTop: 2,
            }}
          >
            {stop.notes ? <span>{stop.notes}</span> : null}
            {stop.source_url ? (
              <>
                {stop.notes ? ' · ' : null}
                <a
                  href={stop.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--tp-primary)', textDecoration: 'none' }}
                >
                  {stop.source || 'source'} →
                </a>
              </>
            ) : null}
          </div>
        )}
      </div>
      {hasCoords && (
        <button
          onClick={handleCopyCoords}
          title="Copy GPS coordinates to clipboard (paste into iOverlander, Park4Night, or any map app)"
          style={{
            fontSize: 10,
            background: 'transparent',
            border: '1px solid var(--tp-border)',
            color: copied ? 'var(--tp-success)' : 'var(--tp-muted)',
            cursor: 'pointer',
            padding: '2px 6px',
            
            borderRadius: 3,
            flexShrink: 0,
          }}
        >
          {copied ? '✓ Copied' : '📋 GPS'}
        </button>
      )}
      {hasCoords && (
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Preview on Google Maps"
          style={{
            fontSize: 10,
            color: 'rgba(124,181,232,0.7)',
            textDecoration: 'none',
            
            padding: '2px 6px',
            flexShrink: 0,
          }}
        >
          map ↗
        </a>
      )}
      {!readonly && !dismissed && (
        <button
          onClick={() => onDismiss(stop.id)}
          title="Dismiss (keeps it for reference)"
          style={{
            fontSize: 10,
            background: 'transparent',
            border: 'none',
            color: 'var(--tp-muted)',
            cursor: 'pointer',
            padding: '2px 4px',
            
          }}
        >
          dismiss
        </button>
      )}
      {!readonly && (
        <button
          onClick={() => onDelete(stop.id)}
          title="Delete"
          style={{
            fontSize: 14,
            background: 'transparent',
            border: 'none',
            color: 'var(--tp-muted)',
            cursor: 'pointer',
            padding: '2px 6px',
          }}
        >
          ×
        </button>
      )}
      {showParkChips && (
        <div style={{ flexBasis: '100%', display: 'flex', gap: 6, paddingLeft: 22, marginTop: 4 }}>
          <a
            href={buildDogParkSearchUrl(stop.lat as number, stop.lng as number)}
            target="_blank"
            rel="noopener noreferrer"
            title="Search Google Maps for dog parks near this stop"
            style={{
              fontSize: 10,
              color: 'rgba(124,232,163,0.85)',
              background: 'rgba(124,232,163,0.08)',
              border: '1px solid rgba(124,232,163,0.2)',
              padding: '2px 8px',
              borderRadius: 3,
              textDecoration: 'none',
              
            }}
          >
            🐕 dog parks
          </a>
          <a
            href={buildParkSearchUrl(stop.lat as number, stop.lng as number)}
            target="_blank"
            rel="noopener noreferrer"
            title="Search Google Maps for parks near this stop"
            style={{
              fontSize: 10,
              color: 'rgba(181,124,232,0.85)',
              background: 'rgba(181,124,232,0.08)',
              border: '1px solid rgba(181,124,232,0.2)',
              padding: '2px 8px',
              borderRadius: 3,
              textDecoration: 'none',
              
            }}
          >
            🌳 parks
          </a>
        </div>
      )}
    </div>
  );
}
