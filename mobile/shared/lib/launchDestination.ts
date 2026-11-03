/**
 * Where a cold launch goes once the location question has settled — the ONE
 * routing decision `mobile/app/index.tsx` makes.
 *
 *   no session token, intro not seen  -> /intro    (a fresh install)
 *   no session token, intro seen      -> /sign-in  (signed out, or a 401)
 *   session token                     -> where the entitlement check sends a
 *                                        blocked account, else /trips
 *
 * The intro is decided ONLY on the no-token branch, and that is the rule that
 * keeps it to new installs: an existing signed-in user never sees it, and a
 * user who signs out lands on /sign-in because `clearToken()` leaves the intro
 * flag alone (introGuard.test.ts holds both).
 *
 * Pure orchestration over injected reads, the same shape as launchLocation.ts,
 * so the root vitest project (the only test runner) can drive every branch.
 * Mirrored to mobile/shared by scripts/sync-shared.mjs.
 */

export type LaunchRoute = '/intro' | '/sign-in' | '/trips' | (string & {});

export interface LaunchDestinationDeps {
  /** True when the keychain holds a session token. Must not throw. */
  hasToken(): Promise<boolean>;
  /** True when this install has already left the intro once. Must not throw. */
  introSeen(): Promise<boolean>;
  /**
   * Where a blocked (past-trial, unpaid) account should land, or null when it
   * is not blocked or the lookup failed. Asked only when there is a token.
   */
  blockedDestination(): Promise<string | null>;
  /**
   * How long the blocked lookup may take before launch gives up and goes to
   * /trips. It runs under the splash, so it must be bounded.
   */
  blockedTimeoutMs: number;
}

export async function resolveLaunchDestination(deps: LaunchDestinationDeps): Promise<LaunchRoute> {
  if (!(await deps.hasToken())) {
    return (await deps.introSeen()) ? '/sign-in' : '/intro';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.blockedTimeoutMs);
  });
  // A lookup that throws is "could not find out", which is treated as entitled
  // on purpose: a phone in a tunnel must not paywall a paying customer.
  const blocked = await Promise.race([deps.blockedDestination().catch(() => null), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return blocked ?? '/trips';
}
