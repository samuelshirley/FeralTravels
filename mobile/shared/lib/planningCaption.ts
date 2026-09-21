import type { EntitlementPayload } from '../types/entitlement';

/** What the caption says to everyone who is not mid-trial. Unchanged since the clip shipped. */
export const PLANNING_VIDEO_COPY = 'Give me a sec — mapping your route and finding fuel…';

/**
 * The caption Penny "sends" with the dog-fetch clip, the last message of setup.
 *
 * The trial line lives HERE, not at the front of her greeting. The greeting is
 * the first-run screen's headline, and "Welcome to your seven-day free trial"
 * as the first and largest thing a new user read put the billing ahead of the
 * question. At the build it is a footnote to something that is already
 * happening.
 *
 * Only a user whose account is in `trial` reads a trial line. A subscriber, a
 * comped account, a spent or expired trial, or an entitlement we could not
 * fetch all get the plain caption — nobody is told about a trial they are not
 * on, and not knowing is never a reason to guess.
 *
 * `trialDaysRemaining` is whole days rounded UP, so 1 means "some part of
 * today" and is worded as the last day rather than "1 more days".
 *
 * Mirrored into the Expo app by `scripts/sync-shared.mjs`.
 */
export function planningCaption(
  entitlement: Pick<EntitlementPayload, 'state' | 'trialDaysRemaining'> | null,
): string {
  if (entitlement?.state !== 'trial') return PLANNING_VIDEO_COPY;
  const days = entitlement.trialDaysRemaining;
  if (days <= 0) return PLANNING_VIDEO_COPY;
  if (days === 1) return "Building this trip now — it's the last day of your free trial.";
  return `Building this trip now, you have ${spell(days)} more days on your free trial.`;
}

function spell(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  return words[n] ?? String(n);
}
