import { z, ZodError } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { reactivateSubscription } from '@/server/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The undo for the break-glass revoke, and the only way out of `revoked`.
 *
 * Before this existed, `/admin/users/[id]` could take access away and could not
 * give it back: the button turned into a dead "Access already revoked" and that
 * was the end of the road. A misfire, or a `REFUND` webhook that turned out to
 * be wrong, was unfixable from the product.
 *
 * It hands back the plan that was there — `pre_revoke_status`, recorded by the
 * revoke — and NOT a fresh one. Re-activating everything to `active` would make
 * this a way to mint free plans out of expired accounts, so an account that was
 * already over when it was revoked comes back over. The clock stays the
 * authority either way: a term that ran out WHILE the account was revoked is a
 * term that ran out, and `resolveAccountState` says so without being told.
 *
 * The reason is required HERE, not merely in the UI, for the same reason as its
 * opposite: a control that moves paid access has to leave a record that
 * survives whoever pressed it, and a form validation is not a record. Both
 * actions write a `subscription_events` row naming the admin, so the pair reads
 * in order months later.
 *
 * Mirrors `../revoke/route.ts` deliberately, down to the ZodError branch — the
 * two are read side by side and a difference between them should mean
 * something.
 */
const bodySchema = z.object({
  userId: z.string().min(1),
  // `.trim()` before `.min(1)` — "   " is not a reason. `required_error` covers
  // the field being ABSENT, which `.min(1)` never sees: without it a body with
  // no `reason` at all came back with zod's bare "Required", which is the one
  // refusal an admin reads as a broken button rather than as their mistake.
  reason: z
    .string({ required_error: 'A reason is required' })
    .trim()
    .min(1, 'A reason is required'),
});

export async function POST(request: Request) {
  try {
    // Cookie-only by design (see guards.ts): the mobile app has no admin
    // surface, and this one grants access rather than merely reading it.
    const admin = await requireAdmin();
    const { userId, reason } = bodySchema.parse(await request.json());

    // `admin.email` rather than `admin.id`: the audit column is read by a human
    // months later, and an opaque uuid answers "who did this?" badly.
    const plan = await reactivateSubscription(userId, admin.email, reason);

    // A refusal is a 400 carrying its own sentence, never a silent 200. All
    // three — no row, not revoked, no recorded pre-revoke status — are the
    // caller being wrong about the account in a way they can only fix by
    // reading what happened, and a quiet success would leave an admin believing
    // they had restored somebody who is still locked out.
    if (!plan.ok) {
      return Response.json({ error: plan.message, reason: plan.reason }, { status: 400 });
    }

    return Response.json({
      ok: true,
      action: plan.action,
      status: plan.action === 'restore' ? plan.status : null,
    });
  } catch (err) {
    // A missing reason is the caller being wrong, not the server failing.
    // errorResponse() would turn it into a 500 with a Zod dump in it, and the
    // admin pressing the button deserves to read the sentence that explains
    // the refusal.
    if (err instanceof ZodError) {
      return Response.json({ error: err.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }
    return errorResponse(err);
  }
}
