import { ZodError } from 'zod';
import { createSessionForEmail } from '@/server/auth/otp';
import { errorResponse } from '@/server/auth/guards';
import { assertSignupGateOpen } from '@/server/payments';
import { exchangeRequestSchema, verifyIdentityToken } from '@/server/auth/oauthIdentity';
import { captureAppleRefreshToken } from '@/server/auth/appleTokens';
import { consumeIdToken, pruneExpiredTokenUses } from '@/server/auth/oauthReplay';

// jose needs Node crypto; keep this off the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Native OAuth exchange: a provider ID token in, a session token out.
 *
 * The iOS app runs Google (authorization code + PKCE) and Sign in with Apple
 * natively, then posts the resulting ID token here. This route verifies that
 * token against the provider's JWKS and mints a session through the SAME
 * createSessionForEmail() the OTP routes use — so a user who signs in with
 * Google on web and Apple on device lands on ONE account, keyed by verified
 * email, with an identical session row either way.
 *
 * Mirrors /api/mobile/otp/verify's response shape exactly, because the app
 * treats all three sign-in paths as one `SessionResult`.
 *
 * Verifying the token proves it is authentic, not that it is fresh, so
 * consumeIdToken() enforces single use and a per-address rate limit before any
 * session is minted — see oauthReplay.ts for why that is a table and not a Map.
 *
 * The payload is `exchangeRequestSchema` (oauthIdentity.ts, where it can be
 * unit-tested): strict, and `authorizationCode` is Apple-only.
 */

export async function POST(req: Request) {
  try {
    const body = exchangeRequestSchema.parse(await req.json().catch(() => ({})));

    const identity = await verifyIdentityToken(body.provider, body.idToken, body.fullName);

    // Between verification and session creation on purpose: a token that has
    // already been spent must not produce a second session, and a caller
    // hammering this route must not be able to keep going. Throws 401
    // TokenAlreadyUsed or 429 RateLimited.
    await consumeIdToken(body.idToken, identity.email, identity.expiresAt);

    /**
     * The sign-up circuit breaker, after the token is proven and before an
     * account can be created from it. Only a NEW address is refused — a
     * returning Google or Apple user signs in through a flood unaffected.
     * Throws 503 `circuit_open`.
     */
    await assertSignupGateOpen(identity.email);

    const session = await createSessionForEmail(identity.email, identity.name, identity.picture);

    /**
     * Sign in with Apple (build 12+): redeem the authorization code for the
     * refresh token account deletion must revoke (App Review 5.1.1(v)).
     * Awaited, because a serverless function can be frozen once the response
     * is sent — but it never throws: a failure is logged to /admin/errors as
     * `apple:token-exchange` and the person is signed in regardless. No code
     * (build 11, or Apple returned none) means nothing to do.
     */
    if (body.provider === 'apple' && body.authorizationCode && identity.subject) {
      await captureAppleRefreshToken({
        userId: session.userId,
        identitySub: identity.subject,
        authorizationCode: body.authorizationCode,
      });
    }

    // Housekeeping, after the work that matters and never blocking it.
    void pruneExpiredTokenUses().catch(() => {});

    /**
     * The response stays the OTP route's shape — id + email — even though a
     * Google exchange now has a name and an avatar in hand. The app reads
     * both from GET /api/me/identity instead, so a user who signed in months
     * ago on an older build still gets their photo, and a photo changed at
     * Google turns up without signing out and back in.
     */
    return Response.json({
      token: session.sessionToken,
      expires: session.expires.toISOString(),
      user: { id: session.userId, email: identity.email },
    });
  } catch (err) {
    // errorResponse only knows HttpError, so an unmapped ZodError would
    // surface as a 500 — same reasoning as /api/mobile/otp/verify.
    if (err instanceof ZodError) {
      return Response.json({ error: 'InvalidRequest' }, { status: 400 });
    }
    return errorResponse(err);
  }
}
