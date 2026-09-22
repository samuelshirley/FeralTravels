/**
 * When the iOS app silently retries POST /api/mobile/oauth/exchange instead of
 * showing the user an error.
 *
 * Shared (mirrored into mobile/shared/) so the policy is unit-tested here
 * rather than only exercised on a phone.
 *
 * Retrying is safe because the provider token is not spent by a failed
 * exchange: the route verifies the token BEFORE `consumeIdToken` records it,
 * so any failure that happens during verification leaves the token reusable
 * (Apple's lasts about ten minutes, Google's about an hour).
 */

/**
 * The exchange's 503: the server could not obtain the provider's signing keys
 * at all, so it never looked at the token. Nothing about the user's sign-in is
 * wrong; asking again in a moment usually works.
 */
export const PROVIDER_UNAVAILABLE = 'ProviderUnavailable';

/**
 * Pauses before each silent retry of a `ProviderUnavailable`. The server has
 * already retried the provider for up to ~4s and fallen back to a persisted
 * key set before answering 503, so these are for an outage of seconds, not
 * milliseconds.
 */
export const PROVIDER_RETRY_DELAYS_MS: readonly number[] = [1500, 3000];

/**
 * ONE silent retry of a 401 `InvalidToken`, for #39.
 *
 * The OTA and the production deploy are unordered, so this app can be talking
 * to a server that predates `ProviderUnavailable` — one that answers a failed
 * key fetch with 401 `InvalidToken`, exactly what a forged token gets. The two
 * cannot be told apart from here, so the app asks once more: against that
 * server it turns a ~1-in-5 failure into ~1-in-25, and against the new server
 * a genuinely bad token is refused twice instead of once, for the cost of one
 * request. Once the server fix is deployed this retry never changes an
 * outcome and can be removed.
 */
export const LEGACY_INVALID_TOKEN_RETRY_DELAY_MS = 1000;

export interface ExchangeFailure {
  status: number;
  code: string | null;
}

/**
 * How long to wait before retrying, or null to stop and show the error.
 * `retriesSoFar` is 0 on the first failure.
 */
export function exchangeRetryDelayMs(failure: ExchangeFailure, retriesSoFar: number): number | null {
  if (failure.status === 503 && failure.code === PROVIDER_UNAVAILABLE) {
    return PROVIDER_RETRY_DELAYS_MS[retriesSoFar] ?? null;
  }
  if (failure.status === 401 && failure.code === 'InvalidToken') {
    return retriesSoFar === 0 ? LEGACY_INVALID_TOKEN_RETRY_DELAY_MS : null;
  }
  return null;
}

/**
 * Run `exchange`, retrying per `exchangeRetryDelayMs`. `classify` turns a
 * thrown error into a status + code, or null for anything that is not an HTTP
 * answer from the exchange (a network failure, a cancelled sheet), which is
 * rethrown untouched. The LAST error is what the caller shows.
 */
export async function withExchangeRetry<T>(
  exchange: () => Promise<T>,
  classify: (err: unknown) => ExchangeFailure | null,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<T> {
  for (let retries = 0; ; retries++) {
    try {
      return await exchange();
    } catch (err) {
      const failure = classify(err);
      const delay = failure ? exchangeRetryDelayMs(failure, retries) : null;
      if (delay === null) throw err;
      await sleep(delay);
    }
  }
}
