import { z } from 'zod';
import { isFixtureEmail, isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { setSubscriptionFixtureState } from '@/server/repos/testSupport';

/**
 * TEST-ONLY: put a fixture account into one of the account states in
 * docs/design/subscriptions.md, so the E2E suite can walk a paywall without
 * waiting a week or spending $9 of Anthropic credit to get there.
 *
 * Three guards, the same three the rest of the `/api/test/*` family carries,
 * and none of them widened for this route:
 *
 *   1. 404 unless `areTestEndpointsEnabled()` — which is `false` on
 *      `VERCEL_ENV === 'production'`, checked first, with no override env var.
 *      None will be honored, ever.
 *   2. The per-run secret echoed in `x-e2e-test-secret` when
 *      `E2E_TEST_ENDPOINTS_SECRET` is set, because the tested preview is a
 *      public URL.
 *   3. **The address must match `FIXTURE_EMAIL_PATTERN` — secret or not.**
 *
 * The third rule is the whole safety argument, and it is worth being blunt
 * about why: strip it and this is an endpoint that grants free subscriptions.
 * Every other guard here is a fact about the deployment — which environment
 * it is, which run is calling — and a deployment fact can be got wrong. The
 * address shape cannot be got wrong by accident, which is precisely the
 * reasoning `test-endpoints.ts` already gives for hardcoding the pattern
 * rather than making it configurable: *"a guard you can widen with an env var
 * is not a guard."* `e2e.` has no MX record, so an address this route accepts
 * can never belong to a person, and no real account can be reached through it
 * even by a caller holding the per-run secret.
 *
 * It sets FIXTURE STATE, not entitlement. `users.created_at`, `users.comped`,
 * a synthetic `usage_events` total and a `subscriptions` row — the same four
 * facts a real account accumulates — and then `getAccountVerdict` decides what
 * they add up to. Nothing here declares anybody entitled, which is what makes
 * the specs built on it worth running.
 *
 * It mints NO sessions. Sign-in stays the real OTP flow or real OAuth; there
 * is no sign-in bypass anywhere in this codebase and this route must not
 * become the first one.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z
    .string()
    .email()
    // Refused in the schema AND again in the repo layer. Two checks because
    // this is the one that must never be missing, and one of them is
    // guaranteed to survive a refactor that moves the other.
    .refine(isFixtureEmail, 'not a fixture address'),
  /**
   * Required on purpose — see the comment on `SubscriptionFixtureInput.comped`.
   * Fixture addresses are comped by design, a comped account can never be
   * paywalled, and a default here is how a paywall suite silently starts
   * asserting nothing.
   */
  comped: z.boolean(),
  /** Age the account past day 7 without waiting a week. Server clock. */
  createdAtDaysAgo: z.number().min(0).max(3650).nullish(),
  /** Synthetic Anthropic spend in dollars. Replaces any previous total. */
  anthropicSpendUsd: z.number().min(0).max(1000).nullish(),
  /** Default true: keeps fake spend from mailing a real support inbox. */
  suppressThresholdAlerts: z.boolean().optional(),
  subscription: z
    .object({
      status: z.enum(['active', 'grace', 'cancelled', 'expired', 'refunded', 'revoked']),
      source: z.enum(['apple_iap', 'promo', 'admin', 'fake']).optional(),
      productId: z.string().nullish(),
      autoRenew: z.boolean().optional(),
      /** Negative = already ended. Null = no end date (an admin/lifetime grant). */
      currentPeriodEndDaysFromNow: z.number().min(-3650).max(3650).nullish(),
    })
    .nullish(),
});

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());
    const state = await setSubscriptionFixtureState(body);
    return Response.json({ ok: true, ...state });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
