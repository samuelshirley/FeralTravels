import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { createPromoCode, listPromoCodes } from '@/server/payments';
import { formatPromoCode } from '@/lib/promoCode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mint and list promo codes, for the block on /admin.
 *
 * `requireAdmin()` is cookie-only by design (see guards.ts) — a bearer token
 * cannot reach it, so the mobile app can never call this however it is built.
 * Same posture as `/api/admin/test-users`.
 *
 * There is deliberately no DELETE and no "revoke this code" action. An unspent
 * code that should not have been issued is handled by not sending it; a SPENT
 * one is a subscription, and subscriptions are ended through the existing
 * break-glass revoke on the user's own admin page, which demands a typed reason
 * and records who pressed it. A second, quieter path to taking access away is
 * not something this feature should introduce.
 */
const createSchema = z.object({
  action: z.literal('create'),
  email: z.string().trim().toLowerCase().email().max(320),
  note: z.string().trim().max(280).optional(),
  /**
   * Days until the code can no longer be REDEEMED. Absent = never goes stale.
   * Distinct from what it grants, which is unlimited either way.
   */
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const rows = await listPromoCodes();
    // Formatted here rather than in the page: the hyphenated form is what gets
    // copied and sent to a person, and one place should decide what that looks
    // like.
    return Response.json({
      codes: rows.map((r) => ({ ...r, display: formatPromoCode(r.code) })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = createSchema.parse(await req.json());

    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const row = await createPromoCode({
      email: body.email,
      note: body.note ?? null,
      createdBy: admin.email,
      expiresAt,
    });

    return Response.json({ code: { ...row, display: formatPromoCode(row.code) } });
  } catch (err) {
    return errorResponse(err);
  }
}
