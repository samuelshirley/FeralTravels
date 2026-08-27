import { z } from 'zod';
import { requireUser, errorResponse } from '@/server/auth/guards';
import { redeemPromoCode } from '@/server/payments';
import { PROMO_ERROR_COPY } from '@/lib/promoCopy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Redeem a promo code for the signed-in account.
 *
 * `requireUser`, NOT `requireEntitledUser`, and that is not an oversight: every
 * caller of this route is by definition someone the paywall has just refused.
 * Gating it on entitlement would make the way out of the paywall reachable only
 * to people who are not behind it. Same reasoning as `GET /api/me/entitlement`.
 *
 * The account is taken from the SESSION, never from the body. There is no
 * `email` field to send, so no request can redeem a code on behalf of an
 * address it does not hold a session for — the binding check compares the code's
 * `email` against the one the server already resolved.
 */
const schema = z.object({
  // Generous on the way in: the shape check lives in `isPromoCodeShape`, after
  // normalization, so somebody pasting `FERAL-4KQP-8XZM ` with a trailing space
  // gets a real answer rather than a Zod error about a regex.
  code: z.string().trim().min(1).max(64),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const { code } = schema.parse(await req.json());

    // `requireUser` types email as nullable, and it genuinely can be: the
    // NextAuth adapter writes whatever the provider returned. A code is bound to
    // an address, so an account without one can never be its recipient. Refused
    // as `wrong_account` rather than 500ing, because that is exactly what it is
    // — and the copy for it already names the fix (sign in with the address you
    // gave us).
    if (!user.email) {
      return Response.json(
        { error: PROMO_ERROR_COPY.promo_wrong_account, code: 'promo_wrong_account' },
        { status: 400 }
      );
    }

    const result = await redeemPromoCode({
      userId: user.id,
      email: user.email,
      rawCode: code,
    });

    if (!result.ok) {
      // 400, not 403: the request was well-formed and authenticated, the code
      // just isn't usable. `code` is the machine-readable field clients branch
      // on — never the message, which is copy and is meant to change.
      return Response.json(
        { error: PROMO_ERROR_COPY[result.reason], code: result.reason },
        { status: 400 }
      );
    }

    // The client re-asks `/api/me/entitlement` rather than believing this — the
    // server is the authority on entitlement, and this is exactly the moment
    // where trusting a 200 would unblock the UI on our own say-so.
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
