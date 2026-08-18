import { z, ZodError } from 'zod';
import { sendOtpCode } from '@/server/auth/otp';
import { errorResponse, HttpError } from '@/server/auth/guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile OTP step 1: email in, code sent via Resend.
 *
 * Same OTP machinery as the web login (same table, same 10-min expiry, same
 * 60s resend cooldown). Unauthenticated by design — requesting a code is the
 * start of sign-in. Response deliberately carries no account information.
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
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'RateLimited') {
        throw new HttpError(429, 'A code was just sent. Wait a minute before requesting another.');
      }
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
