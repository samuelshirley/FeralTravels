'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { asUnitsPref, type UnitsPref } from '@/lib/units';

/**
 * Client-side carrier for the user's metric/imperial display preference.
 *
 * Why a context instead of threading a prop:
 *
 *   - The Distance display component (used in legs / routes / stops / vehicle
 *     card) is rendered inside lots of different parents. Threading the prop
 *     through every intermediate would create a wide change surface for what
 *     should be a single user setting.
 *
 *   - We refresh the value on demand when the user toggles the setting in
 *     Settings. Putting that state in context keeps the toggle and every
 *     consumer in sync without a page reload.
 *
 * The DB always stores km. This context is purely a display + form-input hint.
 *
 * Server pages may pass an `initialUnits` so the first paint matches the
 * stored value (avoids a flash of metric for imperial users). When omitted,
 * the provider fetches `/api/me` once on mount.
 */
interface UnitsContextValue {
  units: UnitsPref;
  /** Optimistically updates context state, then PATCHes the server. Throws on failure. */
  setUnits: (next: UnitsPref) => Promise<void>;
  /** True while the initial fetch (or a setUnits call) is in flight. */
  loading: boolean;
}

const UnitsContext = createContext<UnitsContextValue | null>(null);

export function UnitsProvider({
  initialUnits,
  children,
}: {
  initialUnits?: UnitsPref;
  children: React.ReactNode;
}) {
  const [units, setUnitsState] = useState<UnitsPref>(initialUnits ?? 'metric');
  const [loading, setLoading] = useState(initialUnits == null);

  // First-paint hydration when the parent didn't supply a server-rendered value.
  useEffect(() => {
    if (initialUnits != null) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await apiFetch<{ units_pref?: string }>('/api/me');
        if (!cancelled) setUnitsState(asUnitsPref(me.units_pref));
      } catch {
        // Fall through with default 'metric' — display still works.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialUnits]);

  const setUnits = useCallback(async (next: UnitsPref) => {
    const prev = units;
    setUnitsState(next); // optimistic — toggle feels instant
    setLoading(true);
    try {
      await apiFetch('/api/me/preferences', {
        method: 'PATCH',
        body: { units_pref: next },
      });
    } catch (err) {
      setUnitsState(prev); // roll back on failure so the toggle reflects truth
      throw err;
    } finally {
      setLoading(false);
    }
  }, [units]);

  return (
    <UnitsContext.Provider value={{ units, setUnits, loading }}>
      {children}
    </UnitsContext.Provider>
  );
}

/**
 * Read the current units pref. Defaults to 'metric' when called outside a
 * provider (e.g. in a test) so consumers can render without crashing.
 */
export function useUnits(): UnitsContextValue {
  const ctx = useContext(UnitsContext);
  if (ctx) return ctx;
  return {
    units: 'metric',
    setUnits: async () => {},
    loading: false,
  };
}
