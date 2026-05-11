import { eq } from 'drizzle-orm';
import { getDb, schema } from './db';

/**
 * After the app calls sendOtpCode(), the same code is stored in
 * `email_otp_codes` and emailed via Resend. E2E reads the row here so we
 * don't need a third-party inbox API — the UI path is still the real
 * /login → verify flow.
 */
export async function fetchOtpCodeForEmail(
  email: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  const db = getDb();

  while (Date.now() < deadline) {
    const rows = await db
      .select({ code: schema.emailOtpCodes.code })
      .from(schema.emailOtpCodes)
      .where(eq(schema.emailOtpCodes.email, normalized))
      .limit(1);
    if (rows.length > 0 && rows[0].code) {
      return rows[0].code;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(
    `[e2e/otp-db] No OTP row for ${normalized} within ${timeoutMs}ms. ` +
      'Did sendOtpCode succeed? Check AUTH_RESEND_KEY / rate limit.',
  );
}
