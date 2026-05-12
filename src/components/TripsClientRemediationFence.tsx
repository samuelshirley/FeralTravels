'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, apiFetch } from '@/lib/api';
import VehicleRemediationOverlay, {
  type VehicleRemediationClientSnapshot,
} from '@/components/VehicleRemediationOverlay';

/**
 * Client safety net when SSR missed the vehicle remediation gate (deployment
 * drift, caching edge cases). If incomplete, replaces the hub with the same
 * overlay as the server route.
 */
export default function TripsClientRemediationFence({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<VehicleRemediationClientSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<VehicleRemediationClientSnapshot>('/api/me/vehicle-remediation');
        if (!cancelled) setSnap(data);
      } catch (e) {
        if (!cancelled) {
          console.warn('[TripsClientRemediationFence]', e instanceof ApiError ? e.message : e);
          setSnap(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (snap?.needs_remediation && !snap.done) {
    return <VehicleRemediationOverlay initialSnapshot={snap} returnTo="/trips" />;
  }

  return <>{children}</>;
}
