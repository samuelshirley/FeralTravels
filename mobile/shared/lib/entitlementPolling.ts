/**
 * How long the app waits for the server after Apple takes the money.
 *
 * The whole reason this file exists is that a purchase and an entitlement are
 * two different events separated by a network hop we do not control:
 *
 *   Apple charges → RevenueCat is notified → RevenueCat POSTs our webhook →
 *   `subscriptions` row → `GET /api/me/entitlement` finally says `entitled`.
 *
 * The app is not allowed to shortcut any of that. `purchasePackage` resolving
 * successfully is the CLIENT's claim; `src/server/payments/webhook.ts` is the
 * only thing that may grant access, and it is deliberately unable to tell a
 * real purchase from a fake one. So the app polls, and this file owns the two
 * numbers that decide whether the wait feels instant or feels broken.
 *
 * Pure, with the elapsed time passed in — same reason `states.ts` takes its
 * clock as an argument. The give-up rule is the part worth testing and a
 * version reading `Date.now()` could only be tested by waiting a minute.
 *
 * Mirrored into the Expo app by `scripts/sync-shared.mjs`.
 */

/**
 * The first few gaps, then a steady beat.
 *
 * Front-loaded because the common case is fast — RevenueCat usually delivers
 * within a second or two of the charge — and a flat 5s poll would make the
 * normal path feel four seconds slower than it is for no benefit. After that
 * the tail is what matters and a tighter loop just spends battery.
 */
export const ENTITLEMENT_POLL_DELAYS_MS = [700, 1200, 2000, 3000, 4000] as const;

/** The gap once the front-loaded schedule above runs out. */
export const ENTITLEMENT_POLL_STEADY_MS = 5000;

/**
 * When to stop asking and tell the user their purchase is safe.
 *
 * Sixty seconds is chosen from what the failure looks like from both ends. Too
 * short and a slow-but-working webhook shows a scary message to somebody whose
 * plan switches on ten seconds later. Too long and a user who has paid is
 * staring at a spinner with no idea whether to try again — which is how a
 * double purchase happens.
 *
 * Giving up is NOT an error state. The purchase is real, the webhook retries on
 * its own (5 attempts over ~2.5 hours), and the next app open resolves it. The
 * copy in `purchaseOutcome.ts` says exactly that.
 */
export const ENTITLEMENT_POLL_BUDGET_MS = 60_000;

export interface PollDecision {
  /** Milliseconds to wait before the next `GET /api/me/entitlement`. */
  waitMs: number;
  /** True once the budget is spent: stop polling and show the timeout copy. */
  giveUp: boolean;
}

/**
 * Decide whether to poll again, and how long to wait first.
 *
 * `attempt` is how many polls have already been made (0 before the first one),
 * `elapsedMs` how long has passed since the purchase resolved.
 */
export function nextEntitlementPoll(attempt: number, elapsedMs: number): PollDecision {
  if (elapsedMs >= ENTITLEMENT_POLL_BUDGET_MS) return { waitMs: 0, giveUp: true };
  const waitMs = ENTITLEMENT_POLL_DELAYS_MS[attempt] ?? ENTITLEMENT_POLL_STEADY_MS;
  return { waitMs, giveUp: false };
}
