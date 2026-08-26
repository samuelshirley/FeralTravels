import 'server-only';

/**
 * Who may use the fake-purchase path.
 *
 * The problem this solves: a TestFlight binary points at PRODUCTION (that is
 * the deliberate config in `mobile/eas.json`), and the `/api/test/*` fixture
 * endpoints are hard-off on production with no override — correctly, and that
 * guard is not being weakened for this. So there has to be some way to walk
 * the paywall end-to-end on a real device against the real API before Apple's
 * paperwork is done.
 *
 * TWO conditions, both required. Either alone is not enough.
 *
 * 1. THE ADDRESS SHAPE, hardcoded below and not configurable.
 *
 *    `sam+trial-<anything>@feraltravels.com`. Deliberately a pattern rather
 *    than a list of exact addresses, because every test run wants a NEW
 *    account: reusing one address means a fresh trial is never actually being
 *    tested, just an aged one carrying the last run's trips, usage rows and
 *    subscription. A list would mean editing a Vercel env var before every
 *    run, which is the kind of friction that ends with somebody widening the
 *    var to something careless.
 *
 *    The shape is a real boundary, for the same reason `FIXTURE_EMAIL_PATTERN`
 *    is one in `auth/test-endpoints.ts`: `feraltravels.com` is our own domain,
 *    the OTP for any address at it lands in our own inbox, and nobody else can
 *    complete a sign-in there. Note the file that pattern lives in says it
 *    plainly — *"a guard you can widen with an env var is not a guard"* — which
 *    is exactly why this half is in code.
 *
 * 2. `SUBSCRIPTION_TESTING=1`, which defaults to OFF.
 *
 *    The pattern says who could; this says whether anyone can right now. It is
 *    the switch to flip off the moment RevenueCat is live, without a deploy,
 *    and it means a leaked address shape grants nothing on an environment
 *    where the var was never set.
 *
 * Every grant made this way is written to `subscription_events` with
 * `source: 'fake'`, so a subscription that was never paid for can always be
 * told apart from one that was, months later, by anyone reading the table.
 */
export const TEST_PURCHASE_EMAIL_PATTERN = /^sam\+trial-[a-z0-9-]{1,40}@feraltravels\.com$/i;

export function isTestPurchaseAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  return TEST_PURCHASE_EMAIL_PATTERN.test(email.trim().toLowerCase());
}

/** Same shape as `EnvLike` in auth/test-endpoints.ts, so the guards test alike. */
type EnvLike = Record<string, string | undefined>;

/** The arming switch. Off unless explicitly set to `1`. */
export function testPurchasesArmed(env: EnvLike = process.env): boolean {
  return env.SUBSCRIPTION_TESTING === '1';
}

export function isTestPurchaseAllowed(
  email: string | null | undefined,
  env: EnvLike = process.env
): boolean {
  return testPurchasesArmed(env) && isTestPurchaseAddress(email);
}
