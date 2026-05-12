'use client';

import { apiFetch } from '@/lib/api';
import type { Vehicle } from '@/components/VehicleProfileSection';

/**
 * Module-level in-flight deduplication for GET /api/vehicles.
 *
 * Multiple components (VehicleProfileSection, TripVehicleChip,
 * VehicleRemediationOverlay) independently fetch the vehicle list on mount.
 * Without deduplication this fires 2-3 identical requests on every page load.
 *
 * The cache keeps the in-flight promise so concurrent callers await the same
 * network request. Once resolved, the result is kept for `STALE_MS` so
 * subsequent mounts within the same page reuse it. Any mutation (POST/PATCH/
 * DELETE on vehicles) should call `invalidateVehicleCache()` so the next
 * read goes to the network.
 */

const STALE_MS = 5_000;

let cached: { data: Vehicle[]; ts: number } | null = null;
let inflight: Promise<Vehicle[]> | null = null;

export function invalidateVehicleCache(): void {
  cached = null;
  inflight = null;
}

export async function fetchVehicles(): Promise<Vehicle[]> {
  if (cached && Date.now() - cached.ts < STALE_MS) {
    return cached.data;
  }

  if (inflight) return inflight;

  inflight = apiFetch<Vehicle[]>('/api/vehicles')
    .then((data) => {
      cached = { data, ts: Date.now() };
      inflight = null;
      return data;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });

  return inflight;
}
