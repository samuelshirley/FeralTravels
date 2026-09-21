/**
 * Where the chat panel is in trip setup, as ONE value.
 *
 * This replaces a boolean, `onboardingUiActive`, that silently meant two
 * things: "setup is not running" AND "setup is running but its snapshot has
 * not arrived yet". The snapshot is fetched after mount, so on the first
 * render the boolean was always false, and the empty state — gated on its
 * negation — painted `START HERE` over every first-run trip until the fetch
 * landed. That shipped to TestFlight build 8 behind a test marked `it.fails`,
 * which reports green while the bug is present.
 *
 * `'loading'` is the variant that boolean could not spell. A gate that wants
 * "not in setup" must now say `phase === 'off'` — a positive claim about a
 * known state — and cannot get there by negating something that is still
 * racing a fetch. `onboardingPhaseGuard.test.ts` holds both ChatPanels to it.
 *
 * Mirrored into the Expo app by `scripts/sync-shared.mjs`: both panels derive
 * the phase here, so they cannot drift into two answers.
 */
export type OnboardingPhase = 'off' | 'loading' | 'active' | 'error';

export interface OnboardingPhaseInput {
  /** From the trip's `onboardingState` prop — known synchronously, on the first render. */
  isOnboarding: boolean;
  /** The fetched snapshot, or null until it arrives. Only `state` matters here. */
  snapshot: { state: string } | null;
  /** Set when the snapshot fetch (or a later answer) failed. */
  error: string | null;
}

export function onboardingPhase({ isOnboarding, snapshot, error }: OnboardingPhaseInput): OnboardingPhase {
  if (!isOnboarding) return 'off';
  // A snapshot wins over an error: once one has arrived, a failed ANSWER is
  // shown inline by the card and setup is still running.
  if (snapshot) return snapshot.state === 'done' ? 'off' : 'active';
  return error ? 'error' : 'loading';
}
