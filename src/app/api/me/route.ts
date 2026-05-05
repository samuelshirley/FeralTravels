import { requireUserId, errorResponse } from '@/server/auth/guards';
import { getUnitsPref } from '@/server/repos/users';

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
    const unitsPref = await getUnitsPref(userId);
    return Response.json({ units_pref: unitsPref });
  } catch (err) {
    return errorResponse(err);
  }
}
