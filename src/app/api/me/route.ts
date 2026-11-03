import { requireUserId, errorResponse } from '@/server/auth/guards';
import { getAiConsent, getUnitsPref, getUserTimezone } from '@/server/repos/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tiny "me" endpoint — currently returns just the user-level display
 * preferences the client cares about. Kept narrow on purpose so the React
 * UnitsProvider can call this without pulling down PII (the email/name
 * already come from the NextAuth session).
 */
export async function GET() {
  try {
    const userId = await requireUserId();
    const [unitsPref, timezone, consent] = await Promise.all([
      getUnitsPref(userId),
      getUserTimezone(userId),
      getAiConsent(userId),
    ]);
    // `ai_consent`: whether this account agreed to its content going to
    // Anthropic. False → both clients show the consent sheet before Penny's
    // first send (src/lib/aiConsent.ts). The server refuses regardless.
    // Kept as it was for app builds that predate versions.
    // `ai_consent_version`: the newest sheet agreed to (null = none). Below
    // AI_CONSENT_VERSION, a current client re-asks once with the newer sheet.
    return Response.json({
      units_pref: unitsPref,
      timezone,
      ai_consent: consent.at !== null,
      ai_consent_version: consent.version,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
