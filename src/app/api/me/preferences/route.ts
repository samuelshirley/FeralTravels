import { z } from 'zod';
import { requireUserId, errorResponse } from '@/server/auth/guards';
import { recordAiConsent, setUnitsPref, setUserTimezone } from '@/server/repos/users';
import { AI_CONSENT_VERSION } from '@/lib/aiConsent';

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
  /**
   * The consent sheet's "Agree" (App Review 5.1.2(i)): this account's
   * messages, photos, trip details and location may go to Anthropic.
   * `true` only — there is no way to send `false`, because "Not now" writes
   * nothing and the absence of a timestamp is the refusal.
   */
  ai_consent: z.literal(true).optional(),
  /**
   * Which sheet that Agree was on. Only the CURRENT version is accepted, and
   * only beside `ai_consent: true`. Absent = 1: an app build from before
   * versions showed the Anthropic-only sheet, and its Agree must not grant
   * anything that sheet did not name (TypeSafe).
   */
  ai_consent_version: z.literal(AI_CONSENT_VERSION).optional(),
}).refine((b) => b.ai_consent_version === undefined || b.ai_consent === true, {
  message: 'ai_consent_version needs ai_consent: true',
  path: ['ai_consent_version'],
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
    if (body.ai_consent === true) {
      await recordAiConsent(userId, new Date(), body.ai_consent_version ?? 1);
    }
    return Response.json({
      ok: true,
      units_pref: body.units_pref ?? null,
      timezone,
      ...(body.ai_consent === true
        ? { ai_consent: true, ai_consent_version: body.ai_consent_version ?? 1 }
        : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
