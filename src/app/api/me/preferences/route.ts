import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { setUnitsPref, setUserTimezone } from '@/server/repos/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  units_pref: z.enum(['metric', 'imperial']).optional(),
  /**
   * IANA timezone string from the browser (Intl…timeZone). Re-validated against
   * the Intl zone database in setUserTimezone before it's persisted — an
   * unrecognized zone is silently ignored rather than rejected, so a flaky
   * client value never blocks a units update.
   */
  timezone: z.string().min(1).max(64).optional(),
});

/**
 * Update the signed-in user's display preferences. Handles units_pref and the
 * browser-captured timezone; structured as a generic preferences endpoint so
 * future toggles (e.g. distance precision, day-of-week start) can land here
 * without adding yet another route.
 */
export async function PATCH(req: Request) {
  try {
    const userId = await requireUserId();
    const body = patchSchema.parse(await req.json());
    if (body.units_pref !== undefined) {
      await setUnitsPref(userId, body.units_pref);
    }
    let timezone: string | null = null;
    if (body.timezone !== undefined) {
      timezone = await setUserTimezone(userId, body.timezone);
    }
    return Response.json({
      ok: true,
      units_pref: body.units_pref ?? null,
      timezone,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
