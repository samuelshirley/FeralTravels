import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { sendOtpCode } from '@/server/auth/otp';
import {
  assertTestAddress,
  ageTestAccount,
  createTestAccount,
  deleteTestAccount,
  listTestAccounts,
  readTestAccountOtp,
  resetTestAccount,
} from '@/server/payments/testAccounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Disposable paywall test accounts, for /admin/test-users.
 *
 * `requireAdmin()` is cookie-only by design (see guards.ts) — a bearer token
 * cannot reach this, so the app can never call it.
 *
 * The one thing this route deliberately does NOT have is a "sign in as" action.
 * It hands back an address and a real sign-in code; the sign-in itself happens
 * in the browser, through /login/verify, against the real verifier. See the
 * header of `payments/testAccounts.ts` for why that line is where it is.
 */

const statusSchema = z.enum(['active', 'grace', 'cancelled', 'expired', 'refunded', 'revoked']);

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    ageDays: z.number().int().min(0).max(3650),
    subscription: statusSchema.nullable(),
    periodEndsInDays: z.number().int().min(-3650).max(3650).optional(),
    autoRenew: z.boolean().optional(),
    spendUsd: z.number().min(0).max(1000).optional(),
  }),
  z.object({ action: z.literal('code'), email: z.string().email() }),
  z.object({ action: z.literal('resend'), email: z.string().email() }),
  z.object({ action: z.literal('reset'), email: z.string().email() }),
  z.object({ action: z.literal('age'), email: z.string().email(), days: z.number().int().min(0).max(3650) }),
  z.object({ action: z.literal('delete'), email: z.string().email() }),
]);

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ accounts: await listTestAccounts() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = bodySchema.parse(await req.json());

    switch (body.action) {
      case 'create': {
        const account = await createTestAccount(body);
        // Send immediately so the code is on screen before the admin has
        // switched windows. It is a REAL send — these addresses deliver to our
        // own inbox — so the mail arrives too, and the code in the response is
        // the same one, not a second parallel credential.
        let code: string | null = null;
        try {
          code = await sendOtpCode(account.email);
        } catch (err) {
          // A failed send is not a failed creation. The account exists and the
          // admin can request a code from /login like anybody else.
          console.error('[admin/test-users] initial send failed', err);
        }
        return Response.json({ account, code });
      }
      case 'code':
        return Response.json({ code: await readTestAccountOtp(body.email) });
      case 'resend': {
        // Checked HERE, before sendOtpCode, because this is the one path that
        // reaches it directly. Every other action goes through a helper that
        // asserts internally; this one would otherwise mint and RETURN a
        // sign-in code for any address an admin typed.
        const address = assertTestAddress(body.email);
        // `sendOtpCode` enforces its own resend cooldown and throws
        // 'RateLimited'. Surfaced as 429 rather than swallowed, because the
        // pending code is still valid and the UI should say so.
        try {
          return Response.json({ code: await sendOtpCode(address) });
        } catch (err) {
          if (err instanceof Error && err.message === 'RateLimited') {
            return Response.json(
              { error: 'Too soon — the previous code is still valid.', code: await readTestAccountOtp(address) },
              { status: 429 }
            );
          }
          throw err;
        }
      }
      case 'reset':
        await resetTestAccount(body.email);
        return Response.json({ ok: true });
      case 'age':
        await ageTestAccount(body.email, body.days);
        return Response.json({ ok: true });
      case 'delete':
        await deleteTestAccount(body.email);
        return Response.json({ ok: true });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
