'use client';

import { useCallback, useMemo, useState } from 'react';
import type { Stop, StopType } from '@/types/trip';
import { tripApi, ApiError } from '@/lib/api';
import { parseCoords, needsServerResolution } from '@/lib/coords';

export interface UseStopActionsOptions {
  tripId: number;
  legId: number;
  initialStops: Stop[];
  onChanged?: () => void;
}

/**
 * Encapsulates all stop mutation logic (select, dismiss, delete, swap,
 * add-from-paste, add-from-nearby-place, set-overnight) in a single hook.
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

  // Paste GPS state
  const [pasteValue, setPasteValue] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

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
    async (id: number) => {
      await resilientMutation(
        () => api.selectStop(id, { skipGlobalErrorReport: true }),
        () => setStops((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'selected' } : s)))
      );
    },
    [api, reload]
  );

  const dismiss = useCallback(
    async (id: number) => {
      await resilientMutation(
        () => api.updateStop(id, { status: 'dismissed' }, { skipGlobalErrorReport: true }),
        () => setStops((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'dismissed' } : s)))
      );
    },
    [api, reload]
  );

  const remove = useCallback(
    async (id: number) => {
      if (!confirm('Delete this stop?')) return;
      await resilientMutation(() =>
        api.deleteStop(id, { skipGlobalErrorReport: true })
      );
    },
    [api, reload]
  );

  const swapAlternate = useCallback(
    async (id: number, altIndex: number) => {
      await resilientMutation(() =>
        api.swapStopPrimary(id, altIndex, { skipGlobalErrorReport: true })
      );
    },
    [api, reload]
  );

  const addFromPaste = useCallback(async () => {
    const raw = pasteValue.trim();
    if (!raw) return;
    setPasteBusy(true);
    setPasteError(null);
    try {
      let coords = parseCoords(raw);
      if (!coords && needsServerResolution(raw)) {
        coords = (await api.parseCoords(raw)) as ReturnType<typeof parseCoords>;
      }
      if (!coords) {
        setPasteError(
          'Could not read coordinates — try decimal "lat, lng" or a Google Maps URL.'
        );
        return;
      }
      await api.addStop(legId, {
        stop_type: 'overnight' as StopType,
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
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to add stop';
      setPasteError(msg);
    } finally {
      setPasteBusy(false);
    }
  }, [api, legId, pasteValue, reload]);

  const addNearbyPlace = useCallback(
    async (place: {
      name: string;
      lat: number;
      lng: number;
      googleMapsUri: string | null;
      stopType?: StopType;
    }) => {
      await api.addStop(legId, {
        stop_type: place.stopType ?? 'rest',
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        status: 'selected',
        source: 'google_places',
        source_url: place.googleMapsUri ?? null,
      });
      await reload();
    },
    [api, legId, reload]
  );

  /**
   * Set a nearby place as the leg's overnight stop. Dismisses any existing
   * google_places-sourced overnights first, then inserts the new one.
   */
  const setOvernight = useCallback(
    async (place: {
      name: string;
      lat: number;
      lng: number;
      googleMapsUri: string | null;
    }) => {
      // Dismiss existing auto-suggested overnights
      const existingOvernights = stops.filter(
        (s) =>
          s.stop_type === 'overnight' &&
          s.status !== 'dismissed' &&
          s.source === 'google_places'
      );
      for (const existing of existingOvernights) {
        await api
          .updateStop(existing.id, { status: 'dismissed' }, { skipGlobalErrorReport: true })
          .catch(() => {
            /* stale id — fine */
          });
      }
      await api.addStop(legId, {
        stop_type: 'overnight',
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        status: 'selected',
        source: 'google_places',
        source_url: place.googleMapsUri ?? null,
      });
      await reload();
    },
    [api, legId, stops, reload]
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
    addNearbyPlace,
    setOvernight,
    // Paste GPS
    pasteValue,
    setPasteValue,
    pasteBusy,
    pasteError,
    addFromPaste,
    // Reload
    reload,
  };
}
