import { z } from 'zod';
import { requireAdmin, errorResponse } from '@/server/auth/guards';
import { globalJevMode, JEV_MODES, setGlobalJevMode } from '@/server/repos/jev';
import { logUsageEvent } from '@/server/repos/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The deployment-wide Jev switch, from /admin: 'on' asks Jev first on every
 * classifier-path message (Haiku whenever Jev is not sure), 'compare' has
 * Haiku decide and only logs Jev's answer beside it, 'off' is Haiku only.
 * Accounts with their own override (`/api/admin/jev/user`) ignore it.
 *
 * Same posture as `/api/admin/paywall`: `requireAdmin()` is cookie-only, so the
 * mobile app can never call it, and every flip writes a `usage_events` row with
 * the admin who pressed it — `app_meta` has nowhere to put an author.
 */
const schema = z.object({ mode: z.enum(JEV_MODES) });

export async function GET() {
  try {
    await requireAdmin();
    return Response.json(
      { mode: await globalJevMode() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const { mode } = schema.parse(await req.json());

    await setGlobalJevMode(mode);

    await logUsageEvent({
      userId: admin.id,
      provider: 'admin:jev-switch',
      requests: 0,
      success: true,
      errorMessage: `${admin.email} set Jev to ${mode.toUpperCase()} for every account without an override`,
    }).catch((err) => console.error('[admin/jev] could not record the flip', err));

    console.warn(`[admin/jev] ${admin.email} set Jev to ${mode.toUpperCase()}`);

    return Response.json({ mode: await globalJevMode() });
  } catch (err) {
    return errorResponse(err);
  }
}
