import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getMe, updatePreferences } from "@/lib/api";
import { asUnitsPref, type UnitsPref } from "@/shared/lib/units";

/**
 * Native mirror of src/components/UnitsContext.tsx — same contract, same
 * one-time timezone sync (the source of truth for the driver's "today" in all
 * leg-date math), same optimistic setUnits with rollback.
 */
interface UnitsContextValue {
  units: UnitsPref;
  setUnits: (next: UnitsPref) => Promise<void>;
  loading: boolean;
}

const UnitsContext = createContext<UnitsContextValue | null>(null);

// Module-scoped so the timezone sync fires at most once per app launch.
let tzSynced = false;

export function UnitsProvider({ children }: { children: React.ReactNode }) {
  const [units, setUnitsState] = useState<UnitsPref>("metric");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await getMe();
        if (!cancelled) setUnitsState(asUnitsPref(me.units_pref));
      } catch {
        // Fall through with 'metric' — display still works.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (tzSynced) return;
    tzSynced = true;
    let cancelled = false;
    let tz: string | null = null;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      tz = null;
    }
    if (!tz) return;
    (async () => {
      try {
        const me = await getMe();
        if (cancelled || me.timezone === tz) return;
        await updatePreferences({ timezone: tz });
      } catch {
        // Best-effort — day-math falls back to UTC until this lands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setUnits = useCallback(
    async (next: UnitsPref) => {
      const prev = units;
      setUnitsState(next); // optimistic — the toggle feels instant
      setLoading(true);
      try {
        await updatePreferences({ units_pref: next });
      } catch (err) {
        setUnitsState(prev); // roll back so the toggle reflects truth
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [units]
  );

  return (
    <UnitsContext.Provider value={{ units, setUnits, loading }}>{children}</UnitsContext.Provider>
  );
}

export function useUnits(): UnitsContextValue {
  return (
    useContext(UnitsContext) ?? { units: "metric", setUnits: async () => {}, loading: false }
  );
}
