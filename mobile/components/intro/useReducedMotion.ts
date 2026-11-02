import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * iOS Reduce Motion, live. Same pattern as chat/PennyPlanningVideo.tsx: read
 * once, then follow the system toggle. Unknown (the read failed) is treated as
 * motion allowed, the same default the web uses.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduced(enabled);
      })
      .catch(() => {
        /* unknown → treat as motion allowed */
      });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return reduced;
}
