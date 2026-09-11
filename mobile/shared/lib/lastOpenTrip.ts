import { useSyncExternalStore } from 'react';

/**
 * The trip the user most recently had open — MODULE state, so it outlives the
 * screen that set it.
 *
 * ── The bug this exists to prevent ─────────────────────────────────────────
 *
 * LIST / MAP / CHAT are tabs OF a trip, but the bottom nav is also mounted on
 * screens with no trip in scope (Settings, the trips list). There, `onChange`
 * is undefined and all three items used to navigate to `/trips` — the index.
 * So tapping CHAT from Settings, with Penny mid-answer, dropped the driver on
 * a list of trips rather than back into the conversation they were having
 * (reproduced on a simulator, 2026-09-11).
 *
 * There is nowhere in a component to keep this: the trip screen is exactly
 * what is not mounted at the moment the answer is needed.
 *
 * Session-scoped on purpose — no persistence. "The last chat I had open" is a
 * fact about this sitting of the app; restoring it a week later from disk
 * would be a different feature, and a surprising one.
 */

let lastTripId: string | null = null;
const listeners = new Set<() => void>();

export function rememberLastOpenTrip(tripId: string | null): void {
  const next = tripId || null;
  if (next === lastTripId) return;
  lastTripId = next;
  for (const listener of listeners) listener();
}

export function lastOpenTripId(): string | null {
  return lastTripId;
}

/** Sign-out, and test isolation. */
export function forgetLastOpenTrip(): void {
  rememberLastOpenTrip(null);
}

export function subscribeLastOpenTrip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLastOpenTripId(): string | null {
  return useSyncExternalStore(subscribeLastOpenTrip, lastOpenTripId, lastOpenTripId);
}

/** The three trip tabs the bottom nav offers. Mirrors `MobileTab`. */
export type TripTab = 'list' | 'map' | 'chat';

/**
 * Where a bottom-nav tab should go when there is no trip in scope to toggle.
 *
 * The whole of the decision, as one pure function, because it is the thing
 * that was wrong and the thing the guard tests assert. With no remembered trip
 * it still falls back to the trips index — a driver who has never opened a
 * trip has no chat to be returned to.
 */
export function tripTabDestination(tab: TripTab, tripId: string | null): string {
  if (!tripId) return '/trips';
  return `/trips/${tripId}?tab=${tab}`;
}
