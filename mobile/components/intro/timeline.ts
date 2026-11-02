import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";

/**
 * One clock per preview. `t` runs 0 → LOOP_MS once per loop, linearly, on the
 * native driver. Everything lands by ~3.3 s and then HOLDS until the last
 * 300 ms: the finished frame is the one a person reads, so it gets ~2.4 s of
 * the loop (a 5 s loop left it 1.4 s). Every element derives its opacity and
 * transform from it with `at(...)`, so a whole preview is one animation and cannot fall out of step.
 *
 * Inactive pages hold the first frame (an empty card, so swiping in does not
 * show a finished frame that then blanks and replays); Reduce Motion holds the
 * finished frame (HOLD_AT) and never starts the clock.
 */
export const LOOP_MS = 6000;
/** The moment every element has landed; the static frame for Reduce Motion. */
export const HOLD_AT = 3600;

export function usePreviewClock(active: boolean, reducedMotion: boolean): Animated.Value {
  const t = useRef(new Animated.Value(reducedMotion ? HOLD_AT : 0)).current;
  useEffect(() => {
    if (reducedMotion) {
      t.setValue(HOLD_AT);
      return;
    }
    t.setValue(0);
    if (!active) return;
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: LOOP_MS,
        duration: LOOP_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [active, reducedMotion, t]);
  return t;
}

/**
 * 0 → 1 between `startMs` and `startMs + durMs` with an ease-out shape
 * (approximated by a midpoint, which the native driver can interpolate), held
 * at 1 until the loop's last 300 ms, where everything fades out together so
 * the next loop starts from an empty card.
 */
export function at(t: Animated.Value, startMs: number, durMs: number): Animated.AnimatedInterpolation<number> {
  const s = Math.max(0, startMs);
  const mid = s + durMs * 0.4;
  const end = s + durMs;
  const fadeStart = LOOP_MS - 300;
  return t.interpolate({
    inputRange: [0, s, mid, end, fadeStart, LOOP_MS],
    outputRange: [0, 0, 0.7, 1, 1, 0],
    extrapolate: "clamp",
  });
}

/** `at`, rescaled: from `from` to `to` (e.g. a 10pt slide up to 0). */
export function slide(
  t: Animated.Value,
  startMs: number,
  durMs: number,
  from: number,
  to = 0
): Animated.AnimatedInterpolation<number> {
  return at(t, startMs, durMs).interpolate({ inputRange: [0, 1], outputRange: [from, to] });
}

/** Visible from `inMs` to `outMs` (150 ms fades), hidden otherwise. */
export function between(t: Animated.Value, inMs: number, outMs: number): Animated.AnimatedInterpolation<number> {
  return t.interpolate({
    inputRange: [0, inMs, inMs + 150, outMs, outMs + 150, LOOP_MS],
    outputRange: [0, 0, 1, 1, 0, 0],
    extrapolate: "clamp",
  });
}

/**
 * A highlight that pulses twice after `startMs` and settles at 0 — the
 * "this row is new" ring on the third screen.
 */
export function pulse(t: Animated.Value, startMs: number): Animated.AnimatedInterpolation<number> {
  return t.interpolate({
    inputRange: [0, startMs, startMs + 250, startMs + 550, startMs + 800, startMs + 1100, LOOP_MS],
    outputRange: [0, 0, 1, 0.25, 1, 0, 0],
    extrapolate: "clamp",
  });
}
