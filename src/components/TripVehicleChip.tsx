'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { Vehicle } from '@/components/VehicleProfileSection';

interface Props {
  tripId: number;
  initialVehicleId: number | null;
  readonly?: boolean;
  /** Called after the trip's vehicle_id is successfully PATCHed (refresh legs / fuel state). */
  onTripUpdated?: () => void | Promise<void>;
}

export default function TripVehicleChip({
  tripId,
  initialVehicleId,
  readonly = false,
  onTripUpdated,
}: Props) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [vehicleId, setVehicleId] = useState<number | null>(initialVehicleId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Fetch vehicles on mount, not just when the popup opens. Otherwise the
  // chip's closed-state label falls through to `#${vehicleId}` (e.g. "#2") on
  // first render because we have no name to resolve. One extra request per
  // trip page load. TODO: thread the vehicle name through /api/trip so we
  // don't need this fetch at all.
  useEffect(() => {
    if (vehicles != null) return;
    apiFetch<Vehicle[]>('/api/vehicles')
      .then(setVehicles)
      .catch(() => setVehicles([]));
  }, [vehicles]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      window.addEventListener('mousedown', onClick);
      return () => window.removeEventListener('mousedown', onClick);
    }
  }, [open]);

  const current = vehicles?.find((v) => v.id === vehicleId) ?? null;
  const label = current?.name ?? (vehicleId == null ? 'Pick vehicle' : `#${vehicleId}`);

  async function pick(id: number | null) {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/trips/${tripId}`, {
        method: 'PATCH',
        body: { vehicle_id: id },
      });
      setVehicleId(id);
      setOpen(false);
      await onTripUpdated?.();
    } catch {
      /* ignore — chip stays as before */
    } finally {
      setBusy(false);
    }
  }

  if (readonly) {
    if (!current) return null;
    return (
      <div style={chipStyle} title="Demo trip vehicle">
        <span style={{ opacity: 0.55 }}>vehicle:</span> {current.name}
      </div>
    );
  }

  return (
    <div ref={popRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          ...chipStyle,
          cursor: 'pointer',
          background: open ? 'var(--tp-primary-muted)' : chipStyle.background,
        }}
        title="Change trip vehicle"
        aria-label="Change trip vehicle"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
          <path d="M14 16.5h-4M5 16.5h2M17 16.5h2M5 16.5l2-7h10l2 7M7 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
        </svg>
        <span>{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.55 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            minWidth: 200,
            background: 'var(--tp-surface)',
            border: '1px solid var(--tp-border)',
            borderRadius: 8,
            boxShadow: 'var(--tp-shadow-md)',
            overflow: 'hidden',
            zIndex: 2000,
          }}
        >
          {vehicles == null && (
            <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--tp-muted)' }}>
              Loading…
            </div>
          )}
          {vehicles?.length === 0 && (
            <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--tp-muted)' }}>
              No vehicles. Add one in Settings.
            </div>
          )}
          {vehicles?.map((v) => (
            <button
              key={v.id}
              onClick={() => pick(v.id)}
              disabled={busy}
              style={menuItemStyle(v.id === vehicleId)}
            >
              <span style={{ flex: 1, textAlign: 'left' }}>{v.name}</span>
              {v.is_default && (
                <span style={{ fontSize: 9, color: 'var(--tp-success)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.06em' }}>
                  DEFAULT
                </span>
              )}
              {v.id === vehicleId && (
                <span style={{ color: 'var(--tp-primary)', marginLeft: 6 }}>✓</span>
              )}
            </button>
          ))}
          {vehicleId != null && (
            <button onClick={() => pick(null)} disabled={busy} style={{ ...menuItemStyle(false), color: 'var(--tp-muted)', borderTop: '1px solid var(--tp-border)' }}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  padding: '6px 10px',
  background: 'var(--tp-surface-muted)',
  border: '1px solid var(--tp-border)',
  borderRadius: 14,
  color: 'var(--tp-text)',
  fontFamily: "'JetBrains Mono', monospace",
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
};

function menuItemStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    background: active ? 'var(--tp-primary-muted)' : 'transparent',
    border: 'none',
    padding: '10px 14px',
    fontSize: 13,
    color: 'var(--tp-text)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}
