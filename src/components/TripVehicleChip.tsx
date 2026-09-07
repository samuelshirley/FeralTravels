'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Vehicle } from '@/components/VehicleProfileSection';
import { fetchVehicles } from '@/lib/vehicleCache';
import { TruckIcon } from '@/components/icons';

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
      <TruckIcon />
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
