import { z } from 'zod';
import { signInWithOtpCore } from '@/server/auth/otp';
import { errorResponse, UnauthorizedError } from '@/server/auth/guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile OTP step 2: email + code in, session token out.
 *
 * Runs the EXACT same sign-in as the web verify page (signInWithOtpCore:
 * code verification with attempt limits, find-or-create user, real DB
 * session row). The only difference is delivery: instead of a Set-Cookie,
 * the token is returned in the body for the app to keep in secure storage
 * and send as `Authorization: Bearer <token>`. Guards resolve it against
 * the same sessions table, so revocation and expiry behave identically.
 */
const verifySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  code: z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export async function POST(req: Request) {
  try {
    const body = verifySchema.parse(await req.json().catch(() => ({})));
    const result = await signInWithOtpCore(body.email, body.code);
    if (!result) {
      throw new UnauthorizedError('Invalid or expired code');
    }
    return Response.json({
      token: result.sessionToken,
      expires: result.expires.toISOString(),
      user: { id: result.userId, email: body.email },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
