import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { setUnitsPref } from '@/server/repos/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  units_pref: z.enum(['metric', 'imperial']).optional(),
});

/**
 * Update the signed-in user's display preferences. Currently only handles
 * units_pref; structured as a generic preferences endpoint so future toggles
 * (e.g. distance precision, day-of-week start) can land here without adding
 * yet another route.
 */
export async function PATCH(req: Request) {
  try {
    const userId = await requireUserId();
    const body = patchSchema.parse(await req.json());
    if (body.units_pref !== undefined) {
      await setUnitsPref(userId, body.units_pref);
    }
    return Response.json({ ok: true, units_pref: body.units_pref ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}
