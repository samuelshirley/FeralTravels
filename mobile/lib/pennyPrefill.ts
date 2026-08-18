/**
 * Native stand-in for the web's `window.dispatchEvent(new CustomEvent('penny:prefill'))`.
 *
 * On web, LegCard's "+ Add to this day" button broadcasts a DOM CustomEvent that
 * ChatPanel listens for and turns into a pre-filled composer message. React
 * Native has no DOM and no event target to broadcast on, so this module keeps
 * the same shape — a fire-and-forget emitter with no coupling between the leg
 * card and the chat panel — as a tiny module-level pub/sub instead. Deliberately
 * NOT a React context: the two components live in different panes and neither
 * should have to be re-parented (or re-rendered) for a one-shot signal.
 */

export interface PennyPrefillPayload {
  legId: string;
  dayTitle: string;
  location: string;
  /** The leg's free-text date range, mirroring the web event's `dates`. */
  dates: string | null;
}

type Listener = (payload: PennyPrefillPayload) => void;

const listeners = new Set<Listener>();

/** Broadcast a prefill request. No-op when nothing is subscribed (chat closed). */
export function emitPennyPrefill(payload: PennyPrefillPayload): void {
  // Copy before iterating so a listener that unsubscribes itself mid-dispatch
  // can't mutate the set we're walking.
  for (const listener of [...listeners]) listener(payload);
}

/** Subscribe to prefill requests. Returns an unsubscribe function. */
export function onPennyPrefill(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
