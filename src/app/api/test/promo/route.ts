import { z } from 'zod';
import { isFixtureEmail, isTestRequestAuthorized } from '@/server/auth/test-endpoints';
import { createPromoCode, isPromoGrantMonths } from '@/server/payments';
import { formatPromoCode } from '@/lib/promoCode';

/**
 * TEST-ONLY: mint a promo code for a fixture address, so the E2E suite can walk
 * a redemption without an admin session.
 *
 * The same three guards as the rest of the `/api/test/*` family, none of them
 * widened for this route:
 *
 *   1. 404 unless `areTestEndpointsEnabled()` — false on
 *      `VERCEL_ENV === 'production'`, checked first, no override env honoured.
 *   2. The per-run secret in `x-e2e-test-secret` when the target sets one.
 *   3. **The address must match `FIXTURE_EMAIL_PATTERN`, secret or not.**
 *
 * The third is the one that matters, and it is worth being blunt about why:
 * without it, this is an endpoint that mints free unlimited subscriptions for
 * any address a caller names. Every other guard is a fact about the deployment,
 * and a deployment fact can be got wrong; the address shape cannot be got wrong
 * by accident. `e2e.` has no MX record, so a code minted here is bound to an
 * address no person can ever receive mail at — which means nobody can complete
 * the sign-in that redeeming it requires.
 *
 * It mints a CODE, not access. Redemption still runs the real
 * `redeemPromoCode` through the real route, against a real session obtained
 * through the real OTP flow. There is no sign-in bypass in this codebase and
 * this route must not become the first one.
 */
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  email: z
    .string()
    .email()
    // Refused in the schema AND again by the fixture check below. Two of them,
    // because this is the check that must never go missing and one is
    // guaranteed to survive a refactor that moves the other.
    .refine(isFixtureEmail, 'not a fixture address'),
  /** Days until the code can no longer be redeemed. Absent = no expiry. */
  expiresInDays: z.number().int().min(-3650).max(3650).nullish(),
  /**
   * How long the granted access lasts. Optional HERE, unlike the admin route,
   * and defaulted below — a spec that does not care about the term should not
   * have to name one, and every spec that does care can say so.
   */
  grantMonths: z.number().int().nullish(),
});

export async function POST(req: Request) {
  if (!isTestRequestAuthorized(req)) return new Response('Not found', { status: 404 });
  try {
    const body = bodySchema.parse(await req.json());
    if (!isFixtureEmail(body.email)) return new Response('Not found', { status: 404 });

    const expiresAt =
      body.expiresInDays === null || body.expiresInDays === undefined
        ? null
        : // Negative is allowed on purpose: an already-expired code is a state a
          // spec has to be able to produce, and waiting a day for one is not a
          // test strategy.
          new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);

    const row = await createPromoCode({
      email: body.email,
      note: 'e2e fixture',
      createdBy: 'e2e',
      expiresAt,
      // 12 unless a spec asks otherwise. The admin form has no default on
      // purpose; a fixture wants one so the common case stays one line.
      grantMonths: isPromoGrantMonths(body.grantMonths ?? 12) ? ((body.grantMonths ?? 12) as 6 | 12) : 12,
    });

    return Response.json({ ok: true, code: row.code, display: formatPromoCode(row.code) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
