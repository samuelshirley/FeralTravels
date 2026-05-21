'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Vehicle } from '@/components/VehicleProfileSection';
import { fetchVehicles } from '@/lib/vehicleCache';

interface Props {
  tripId: string;
  initialVehicleId: string | null;
  readonly?: boolean;
  /** Called after the trip's vehicle_id is successfully PATCHed (refresh legs / fuel state). */
  onTripUpdated?: () => void | Promise<void>;
}

/**
 * Display-only chip showing the trip's vehicle name in the header.
 * No picker — the vehicle is chosen during onboarding or changed in Settings.
 * Renders nothing until a vehicle is assigned.
 */
export default function TripVehicleChip({
  initialVehicleId,
}: Props) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [vehicleId, setVehicleId] = useState<string | null>(initialVehicleId);

  useEffect(() => {
    setVehicleId(initialVehicleId);
  }, [initialVehicleId]);

  const loadVehicles = useCallback(async () => {
    try {
      const list = await fetchVehicles();
      setVehicles(list);
    } catch {
      setVehicles([]);
    }
  }, []);

  useEffect(() => {
    void loadVehicles();
  }, [loadVehicles]);

  const current = vehicles?.find((v) => v.id === vehicleId) ?? null;

  if (!current) return null;
  return (
    <div style={chipStyle} title={`Trip vehicle: ${current.name}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.55 }}>
        <path d="M14 16.5h-4M5 16.5h2M17 16.5h2M5 16.5l2-7h10l2 7M7 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
      </svg>
      <span>{current.name}</span>
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
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
};
