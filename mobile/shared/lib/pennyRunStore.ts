import { useSyncExternalStore } from 'react';

/**
 * Which trips have a Penny turn in flight, keyed by trip id — MODULE state,
 * deliberately not component state.
 *
 * ── The bug this exists to prevent ─────────────────────────────────────────
 *
 * "Penny is working" used to live in two pieces of screen-local `useState`:
 * `thinking` in the native trip workspace (which drives the bottom nav's dot)
 * and `loading` inside ChatPanel (which drives the THINKING/READY pill and the
 * typing bubble). Both start at `false`. So any fresh mount of the chat screen
 * — and leaving a trip and coming back is exactly that — rendered READY, no
 * typing bubble and no planning clip, while the server was still working.
 *
 * Measured on a real simulator, 2026-09-11: `penny_turns.status` read
 * `running` at 12:51:48 and 12:52:11; the live view hierarchy sampled at
 * 12:52:10 contained a text node reading `READY` and no `THINKING` node at
 * all. The driver's only signal that anything was happening was gone, on a
 * turn that routinely runs 60-90 seconds.
 *
 * ── Why a SET of turn keys and not a boolean ──────────────────────────────
 *
 * Two mounts of the chat screen can be tracking the same turn at once (the
 * one that sent it, still streaming; and a later one that hydrated from the
 * server and is polling). A boolean would let whichever finished first clear
 * the indicator out from under the other. A set keyed by the turn's
 * idempotency key makes `begin` and `end` idempotent, lets both observers
 * report the same turn without double-counting it, and still counts a second,
 * genuinely different turn queued behind the first.
 *
 * ── Why the store is not the only source of truth ─────────────────────────
 *
 * A store is per-process, so it answers nothing after the app is killed. It is
 * seeded on mount from `GET /api/trips/[id]/turns`, whose `status` is the real
 * answer; `isTurnInFlight` below is the rule both clients read it with.
 */

/** trip id -> the idempotency keys of the turns believed to be in flight. */
const running = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Record that a turn has started for this trip. Idempotent. */
export function beginPennyRun(tripId: string, turnKey: string): void {
  if (!tripId || !turnKey) return;
  let keys = running.get(tripId);
  if (!keys) {
    keys = new Set<string>();
    running.set(tripId, keys);
  }
  if (keys.has(turnKey)) return;
  keys.add(turnKey);
  emit();
}

/** Record that a turn has finished. Idempotent, and a no-op for unknown keys. */
export function endPennyRun(tripId: string, turnKey: string): void {
  const keys = running.get(tripId);
  if (!keys || !keys.delete(turnKey)) return;
  if (keys.size === 0) running.delete(tripId);
  emit();
}

export function isPennyRunning(tripId: string): boolean {
  return (running.get(tripId)?.size ?? 0) > 0;
}

/** The keys currently believed in flight — for tests and diagnostics. */
export function pennyRunKeys(tripId: string): string[] {
  return [...(running.get(tripId) ?? [])];
}

/** Sign-out, and test isolation. */
export function resetPennyRuns(): void {
  if (running.size === 0) return;
  running.clear();
  emit();
}

export function subscribePennyRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The two `penny_turns.status` values that mean the server has not finished.
 * `queued` counts: a turn waiting behind another is work the user is waiting
 * on, and showing READY for it is the same lie as showing it for `running`.
 */
export function isTurnInFlight(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * Fold a turn record read from the server into the store. Used on mount, so a
 * screen that was never the one to send the turn still shows it — and so a
 * store entry left behind by a turn that ended without its sender running its
 * cleanup is cleared rather than pinning the indicator on forever.
 */
export function reconcilePennyRun(
  tripId: string,
  turn: { status?: string | null; idempotency_key?: string | null } | null | undefined
): void {
  const key = turn?.idempotency_key;
  if (!key) return;
  if (isTurnInFlight(turn?.status)) beginPennyRun(tripId, key);
  else endPennyRun(tripId, key);
}

/**
 * Is a turn in flight for this trip? Re-renders on every change to the store.
 *
 * `getServerSnapshot` is the same reader: on the server the map is empty, so it
 * answers `false`, which is what a page rendered before hydration should say.
 */
export function usePennyRunning(tripId: string): boolean {
  const read = () => isPennyRunning(tripId);
  return useSyncExternalStore(subscribePennyRuns, read, read);
}
