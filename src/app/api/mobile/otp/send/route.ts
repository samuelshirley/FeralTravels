import { z, ZodError } from 'zod';
import { OtpRateLimitError, retryAfterSeconds, sendOtpCode } from '@/server/auth/otp';
import { errorResponse, HttpError } from '@/server/auth/guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile OTP step 1: email in, code sent via Resend.
 *
 * Same OTP machinery as the web login (same table, same 10-min expiry, same
 * escalating resend ladder). Unauthenticated by design — requesting a code is
 * the start of sign-in, which is also why the ladder exists: this route puts
 * real email in any inbox a caller names. Response deliberately carries no
 * account information.
 */
const sendSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
});

export async function POST(req: Request) {
  try {
    const body = sendSchema.parse(await req.json().catch(() => ({})));
    try {
      await sendOtpCode(body.email);
    } catch (err) {
      // The app needs the number, not a sentence with a number baked into it:
      // it drives the same countdown the web verify screen runs, and the
      // ladder means the wait is no longer always "a minute".
      /*
       * `instanceof` AND the message. The class check is the precise one, but
       * it compares constructor identity — and a module loaded twice (Next's
       * dev bundler splits chunks, and a route can end up with its own copy)
       * makes a genuine OtpRateLimitError fail it. The message is pinned to
       * exactly 'RateLimited' for the four call sites that compare it across
       * an HTTP boundary; leaning on it here too costs nothing and removes a
       * failure mode where a throttled user is told the email system is down.
       */
      const rateLimited =
        err instanceof OtpRateLimitError ||
        (err instanceof Error && err.message === 'RateLimited');
      if (rateLimited) {
        const retryAfter =
          err instanceof OtpRateLimitError ? retryAfterSeconds(err.retryAfterMs) : 1;
        return Response.json(
          { error: 'RateLimited', retryAfter },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
      }
      /*
       * LOG THE CAUSE. This branch used to discard `err` entirely, so every
       * failure — a missing Resend key, a database error inside the throttle,
       * a template crash — reached the user as one generic sentence and left
       * nothing behind to diagnose it with. It cost two simulator runs.
       */
      console.error('[mobile/otp/send] sendOtpCode failed:', err);
      throw new HttpError(502, 'Could not send the sign-in email. Try again in a moment.');
    }
    return Response.json({ ok: true });
  } catch (err) {
    // Zod validation failures are client errors. errorResponse only knows
    // HttpError, so an unmapped ZodError would surface as a 500.
    if (err instanceof ZodError) {
      return Response.json({ error: 'Enter a valid email address and 6-digit code.' }, { status: 400 });
    }
    return errorResponse(err);
  }
}
