import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { JEV_MODES, setUserJevOverride } from '@/server/repos/jev';
import { logUsageEvent } from '@/server/repos/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One account's Jev override, from /admin/users/[id]: `null` follows the
 * global switch, 'on' forces Jev-first, 'compare' forces Haiku-decides with
 * Jev logged beside it, 'off' forces Haiku only.
 *
 * The sibling of `/api/admin/jev`, as `/api/admin/paywall/user` is of
 * `/api/admin/paywall`: it lets Jev be tried on one account while the global
 * switch stays off, and lets one account be held on Haiku while it is on.
 * Cookie-only admin, Zod-validated, and every change logged with its author.
 */
const schema = z.object({
  userId: z.string().min(1),
  mode: z.enum(JEV_MODES).nullable(),
});

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const { userId, mode } = schema.parse(await req.json());

    const found = await setUserJevOverride(userId, mode);
    if (!found) {
      return Response.json({ error: 'No such account' }, { status: 404 });
    }

    const label = mode === null ? 'FOLLOW GLOBAL' : mode.toUpperCase();
    await logUsageEvent({
      userId: admin.id,
      provider: 'admin:jev-user-override',
      requests: 0,
      success: true,
      errorMessage: `${admin.email} set Jev to ${label} for ${userId}`,
    }).catch((err) => console.error('[admin/jev/user] could not record the change', err));

    console.warn(`[admin/jev/user] ${admin.email} set Jev to ${label} for ${userId}`);

    return Response.json({ userId, mode });
  } catch (err) {
    return errorResponse(err);
  }
}
