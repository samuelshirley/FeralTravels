'use client';

import { useCallback, useMemo, useState } from 'react';
import type { Stop } from '@/types/trip';
import { tripApi, ApiError } from '@/lib/api';

export interface UseStopActionsOptions {
  tripId: string;
  legId: string;
  initialStops: Stop[];
  onChanged?: () => void;
}

/**
 * Encapsulates all stop mutation logic (select, dismiss, delete, swap) in a
 * single hook. There is no paste-a-link path here any more: pasting a Maps
 * link is a chat message (`resolveMapsLinksInMessage` resolves it and Penny
 * writes the stop through `add_stop`), and the day-card version forwarded
 * the coordinate PROVENANCE (`google_maps`) into the stop's AUTHOR column and
 * 500'd on every Maps link (2026-09-04).
 *
 * Separated from UI rendering to support the micro-frontend architecture:
 * any component that works with stops can use this hook without coupling
 * to a specific rendering approach.
 */
export function useStopActions({
  tripId,
  legId,
  initialStops,
  onChanged,
}: UseStopActionsOptions) {
  const api = useMemo(() => tripApi(tripId), [tripId]);
  const [stops, setStops] = useState<Stop[]>(initialStops);

  /**
   * Reload stops from server after a mutation. Notifies parent via
   * onChanged callback.
   */
  const reload = useCallback(async () => {
    try {
      const data = await api.listStopsForLeg(legId);
      if (Array.isArray(data)) setStops(data as Stop[]);
      onChanged?.();
    } catch {
      /* ignore */
    }
  }, [api, legId, onChanged]);

  /** Sync with parent when initialStops prop changes. */
  const syncInitialStops = useCallback((newStops: Stop[]) => {
    setStops(newStops);
  }, []);

  /**
   * 404-resilient mutation wrapper. Auto fuel replans can delete stop IDs
   * out from under the UI — if the server returns 404, silently reload.
   */
  async function resilientMutation(
    fn: () => Promise<unknown>,
    optimisticUpdate?: () => void
  ) {
    optimisticUpdate?.();
    try {
      await fn();
      await reload();
    } catch (err) {
      await reload();
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }

  const select = useCallback(
    async (id: string) => {
      await resilientMutation(
        () => api.selectStop(id, { skipGlobalErrorReport: true }),
        () => setStops((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'selected' } : s)))
      );
    },
    [api, reload]
  );

  const dismiss = useCallback(
    async (id: string) => {
      await resilientMutation(
        () => api.updateStop(id, { status: 'dismissed' }, { skipGlobalErrorReport: true }),
        () => setStops((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'dismissed' } : s)))
      );
    },
    [api, reload]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!confirm('Delete this stop?')) return;
      await resilientMutation(() =>
        api.deleteStop(id, { skipGlobalErrorReport: true })
      );
    },
    [api, reload]
  );

  const swapAlternate = useCallback(
    async (id: string, altIndex: number) => {
      await resilientMutation(() =>
        api.swapStopPrimary(id, altIndex, { skipGlobalErrorReport: true })
      );
    },
    [api, reload]
  );

  // Derived data
  const activeStops = stops.filter((s) => s.status !== 'dismissed');
  const dismissedStops = stops.filter((s) => s.status === 'dismissed');

  return {
    stops,
    activeStops,
    dismissedStops,
    syncInitialStops,
    // Mutations
    select,
    dismiss,
    remove,
    swapAlternate,
    // Reload
    reload,
  };
}
