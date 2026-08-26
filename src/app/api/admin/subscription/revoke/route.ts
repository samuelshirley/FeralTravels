import { z, ZodError } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { revokeSubscription } from '@/server/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin break-glass: take access away from one account.
 *
 * NOT a refund. There is no developer-initiated refund for an Apple IAP — the
 * money is Apple's to return, and this endpoint moves no money at all. It
 * exists for genuine abuse and for a `REFUND` webhook that never arrived.
 * Everything routine is automatic: the cap blocks at $8.50 on its own and a
 * refund notification revokes on its own. If this route is ever the normal way
 * something happens, the automation is broken and that is the bug to fix.
 *
 * Cancelling is NOT a reason to call it. A cancelled subscriber keeps the term
 * they bought — `resolveAccountState` is explicit about that, and this button
 * existing must not quietly turn the policy into a habit.
 *
 * The reason is required HERE, not merely in the UI: a control that takes away
 * paid time has to leave a record that survives whoever pressed it, and a form
 * validation is not a record. `revokeSubscription` re-checks the trimmed
 * string too, so an empty reason is refused twice.
 */
const bodySchema = z.object({
  userId: z.string().min(1),
  // `.trim()` before `.min(1)` — "   " is not a reason.
  reason: z.string().trim().min(1, 'A reason is required'),
});

export async function POST(request: Request) {
  try {
    // Cookie-only by design (see guards.ts): the mobile app has no admin
    // surface and this is the most destructive control in the product.
    const admin = await requireAdmin();
    const { userId, reason } = bodySchema.parse(await request.json());

    // `admin.email` rather than `admin.id`: the audit column is read by a
    // human months later, and an opaque uuid answers "who did this?" badly.
    await revokeSubscription(userId, admin.email, reason);

    return Response.json({ ok: true });
  } catch (err) {
    // A missing reason is the caller being wrong, not the server failing.
    // errorResponse() would turn it into a 500 with a Zod dump in it, and the
    // admin pressing the button deserves to read the sentence that explains
    // the refusal.
    if (err instanceof ZodError) {
      return Response.json(
        { error: err.issues[0]?.message ?? 'Invalid request' },
        { status: 400 }
      );
    }
    return errorResponse(err);
  }
}
