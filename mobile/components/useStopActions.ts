import { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";
import type { Stop } from "@/shared/types/trip";
import { tripApi, ApiError } from "@/lib/api";
import { useErrors } from "@/lib/errors";

export interface UseStopActionsOptions {
  tripId: string;
  legId: string;
  initialStops: Stop[];
  onChanged?: () => void;
}

/**
 * Native port of src/components/stops/useStopActions.ts.
 *
 * Encapsulates all stop mutation logic (select, dismiss, delete, swap) in a
 * single hook. No paste-a-link path — see the web hook for why it went.
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
  const { notify } = useErrors();

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
   *
   * Divergence from web: the web rethrows a non-404 and lets the browser
   * swallow the unhandled rejection (the global ErrorNotifier already showed
   * it). In RN an unhandled rejection is a red box / LogBox warning, so we
   * end the chain here and surface the message through the app's toast.
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
      if (!(err instanceof ApiError) || err.status !== 404) {
        notify(err instanceof Error && err.message ? err.message : "Failed to update stop");
      }
    }
  }

  const select = useCallback(
    async (id: string) => {
      await resilientMutation(
        () => api.selectStop(id, { skipGlobalErrorReport: true }),
        () =>
          setStops((prev) =>
            prev.map((s) => (s.id === id ? { ...s, status: "selected" } : s))
          )
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, reload]
  );

  const dismiss = useCallback(
    async (id: string) => {
      await resilientMutation(
        () => api.updateStop(id, { status: "dismissed" }, { skipGlobalErrorReport: true }),
        () =>
          setStops((prev) =>
            prev.map((s) => (s.id === id ? { ...s, status: "dismissed" } : s))
          )
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, reload]
  );

  const remove = useCallback(
    (id: string) => {
      // `confirm()` is a blocking browser API with no native equivalent —
      // Alert is callback-based, so the delete runs from the button handler
      // rather than after an awaited boolean. Same copy, same two outcomes.
      Alert.alert("Delete this stop?", undefined, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void resilientMutation(() => api.deleteStop(id, { skipGlobalErrorReport: true }));
          },
        },
      ]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, reload]
  );

  const swapAlternate = useCallback(
    async (id: string, altIndex: number) => {
      await resilientMutation(() =>
        api.swapStopPrimary(id, altIndex, { skipGlobalErrorReport: true })
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, reload]
  );

  // Derived data
  const activeStops = stops.filter((s) => s.status !== "dismissed");
  const dismissedStops = stops.filter((s) => s.status === "dismissed");

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
