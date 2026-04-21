'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FuelStatus, Stop, StopType } from '@/types/trip';
import { tripApi, ApiError } from '@/lib/api';
import { buildExternalSpotUrls } from '@/lib/maps';
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
   * Current lifecycle of the auto fuel-stop computation for this leg.
   * Drives the "Plan fuel" button label and whether we show a spinner
   * vs a retry affordance.
   */
  fuelStatus?: FuelStatus;
  onChanged?: () => void;
  readonly?: boolean;
}

const TYPE_ORDER: StopType[] = ['fuel', 'water', 'food', 'overnight', 'rest', 'other'];

const TYPE_META: Record<StopType, { label: string; color: string; icon: string }> = {
  fuel: { label: 'Fuel', color: '#E8D57C', icon: '⛽' },
  water: { label: 'Water', color: '#7CB5E8', icon: '💧' },
  food: { label: 'Food', color: '#E8927C', icon: '🍴' },
  overnight: { label: 'Overnight', color: '#B57CE8', icon: '🌙' },
  rest: { label: 'Rest', color: '#7CE8A3', icon: '☕' },
  other: { label: 'Other', color: 'rgba(255,255,255,0.5)', icon: '📍' },
};

const MONO = "'JetBrains Mono', monospace";

export default function StopsSection({
  tripId,
  legId,
  legEndName,
  legEndCoords,
  legStartCoords,
  initialStops,
  fuelStatus = 'none',
  onChanged,
  readonly = false,
}: StopsSectionProps) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const [stops, setStops] = useState<Stop[]>(initialStops);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<StopType>('overnight');
  // Drives the fuel-stops button. We treat the server-reported
  // `fuelStatus` as the source of truth, but fall back to a local
  // 'computing' while a POST is in flight so the spinner is responsive
  // even before the parent re-fetches the trip.
  const [localFuelStatus, setLocalFuelStatus] = useState<FuelStatus>(fuelStatus);
  const [fuelError, setFuelError] = useState<string | null>(null);

  useEffect(() => {
    setStops(initialStops);
  }, [initialStops]);

  useEffect(() => {
    // Server state wins when it changes — clears any stale local override.
    setLocalFuelStatus(fuelStatus);
  }, [fuelStatus]);

  const hasStartAndEnd =
    legEndCoords.lat != null &&
    legEndCoords.lng != null &&
    legStartCoords?.lat != null &&
    legStartCoords?.lng != null;

  async function handlePlanFuel() {
    if (!hasStartAndEnd || localFuelStatus === 'computing') return;
    setLocalFuelStatus('computing');
    setFuelError(null);
    try {
      const res = await api.planFuelStops(legId);
      if (res.status === 'failed') {
        setLocalFuelStatus('failed');
        setFuelError(res.reason ?? 'Could not plan fuel stops.');
      } else {
        // Re-fetch stops so the newly inserted ones render; the parent
        // trip refresh picks up the new fuel_status.
        await reload();
        setLocalFuelStatus('ready');
      }
    } catch (err) {
      setLocalFuelStatus('failed');
      setFuelError(err instanceof Error ? err.message : 'Could not plan fuel stops.');
    }
  }

  const hasEndCoords = legEndCoords.lat != null && legEndCoords.lng != null;
  const externalUrls = hasEndCoords
    ? buildExternalSpotUrls(legEndCoords.lat as number, legEndCoords.lng as number, legEndName ?? undefined)
    : null;

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
          'Could not read coordinates from that — try decimal "lat, lng" or a Google Maps / iOverlander / Park4Night URL.'
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
        background: 'rgba(255,255,255,0.03)',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.06)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: 'rgba(255,255,255,0.35)',
          fontFamily: MONO,
          marginBottom: 8,
        }}
      >
        STOPS
      </div>

      {!readonly && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={handlePlanFuel}
            disabled={!hasStartAndEnd || localFuelStatus === 'computing'}
            title={
              hasStartAndEnd
                ? 'Find gas stations along this leg using your vehicle range'
                : 'Set start and end coordinates first'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              fontFamily: MONO,
              padding: '6px 10px',
              background:
                localFuelStatus === 'computing'
                  ? 'rgba(232,213,124,0.1)'
                  : localFuelStatus === 'ready'
                    ? 'rgba(124,232,163,0.1)'
                    : 'rgba(255,255,255,0.04)',
              color:
                localFuelStatus === 'ready'
                  ? '#7CE8A3'
                  : localFuelStatus === 'failed'
                    ? '#E8927C'
                    : 'rgba(255,255,255,0.75)',
              border: `1px solid ${
                localFuelStatus === 'ready'
                  ? 'rgba(124,232,163,0.25)'
                  : localFuelStatus === 'failed'
                    ? 'rgba(232,146,124,0.3)'
                    : 'rgba(255,255,255,0.12)'
              }`,
              borderRadius: 4,
              cursor: hasStartAndEnd && localFuelStatus !== 'computing' ? 'pointer' : 'default',
              opacity: hasStartAndEnd ? 1 : 0.45,
            }}
          >
            {localFuelStatus === 'computing' && (
              <Spinner size={10} thickness={2} color="#E8D57C" />
            )}
            <span>⛽</span>
            {localFuelStatus === 'computing'
              ? 'Planning fuel…'
              : localFuelStatus === 'ready'
                ? 'Replan fuel'
                : localFuelStatus === 'failed'
                  ? 'Retry fuel plan'
                  : 'Plan fuel stops'}
          </button>
          {fuelError && (
            <span
              style={{
                fontSize: 11,
                color: '#E8927C',
                maxWidth: 360,
              }}
            >
              {fuelError}
            </span>
          )}
        </div>
      )}

      {hasEndCoords && externalUrls && !readonly && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <ExternalChip
            href={externalUrls.iOverlander}
            label="iOverlander"
            hint="Find overnight spots within 10km of this leg's end"
          />
          <ExternalChip
            href={externalUrls.park4Night}
            label="Park4Night"
            hint="Find overnight spots within 10km of this leg's end"
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
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 4,
              color: '#fff',
              fontSize: 11,
              padding: '6px 8px',
              fontFamily: MONO,
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
            placeholder="Paste GPS (48.8566, 2.3522) or a Google Maps / iOverlander URL"
            disabled={pasteBusy}
            style={{
              flex: '1 1 280px',
              minWidth: 200,
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
            onClick={handleAddFromPaste}
            disabled={pasteBusy || !pasteValue.trim()}
            style={{
              fontSize: 11,
              background: pasteBusy ? 'rgba(124,181,232,0.1)' : '#7CB5E8',
              border: 'none',
              color: pasteBusy ? 'rgba(124,181,232,0.6)' : '#000',
              padding: '6px 14px',
              borderRadius: 4,
              cursor: pasteBusy || !pasteValue.trim() ? 'default' : 'pointer',
              fontWeight: 600,
              fontFamily: MONO,
            }}
          >
            {pasteBusy ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {pasteError && (
        <div style={{ fontSize: 11, color: '#E8927C', marginBottom: 10 }}>{pasteError}</div>
      )}

      {groups.length === 0 && (
        <div
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            fontFamily: MONO,
          }}
        >
          {readonly
            ? 'No stops yet.'
            : hasEndCoords
              ? 'No stops yet. Tap an app above, then paste the GPS of what you find.'
              : 'No destination coords yet — add lat/lng to the leg to unlock external search.'}
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
              fontFamily: MONO,
              color: 'rgba(255,255,255,0.3)',
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
        color: '#7CB5E8',
        padding: '4px 10px',
        borderRadius: 4,
        cursor: 'pointer',
        textDecoration: 'none',
        fontFamily: MONO,
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
          fontFamily: MONO,
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

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 0',
        fontSize: 12,
        color: dismissed ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.8)',
        borderTop: '1px solid rgba(255,255,255,0.05)',
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
            border: `1.5px solid ${selected ? '#7CE8A3' : 'rgba(255,255,255,0.3)'}`,
            background: selected ? '#7CE8A3' : 'transparent',
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
            border: `1.5px solid ${selected ? '#7CE8A3' : 'rgba(255,255,255,0.15)'}`,
            background: selected ? '#7CE8A3' : 'transparent',
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span
            style={{
              fontWeight: selected ? 600 : 400,
              color: selected ? '#fff' : 'inherit',
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
                color: 'rgba(255,255,255,0.4)',
                fontFamily: MONO,
              }}
            >
              ~{stop.distance_from_start_km} km
            </span>
          )}
          {stop.fuel_type && (
            <span
              style={{
                fontSize: 10,
                color: 'rgba(255,255,255,0.4)',
                fontFamily: MONO,
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
              color: 'rgba(255,255,255,0.35)',
              fontFamily: MONO,
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
                  style={{ color: '#7CB5E8', textDecoration: 'none' }}
                >
                  {stop.source || 'source'} →
                </a>
              </>
            ) : null}
          </div>
        )}
      </div>
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
            fontFamily: MONO,
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
            color: 'rgba(255,255,255,0.4)',
            cursor: 'pointer',
            padding: '2px 4px',
            fontFamily: MONO,
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
            color: 'rgba(255,255,255,0.4)',
            cursor: 'pointer',
            padding: '2px 6px',
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
