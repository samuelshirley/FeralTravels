import { requireUserId, errorResponse } from '@/server/auth/guards';
import { getUserIdentity } from '@/server/repos/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The signed-in user's own identity, for the account button and menu.
 *
 * This exists because the iOS app has no server-rendered session to read a
 * name or photo out of the way the web does — it only knows the address it
 * put in the keychain at sign-in, which is why the avatar there was a pair of
 * initials while the web showed the Google photo.
 *
 * Deliberately NOT folded into `GET /api/me`. That route is called by
 * `UnitsProvider` on every page load and is kept to units_pref + timezone on
 * purpose; widening it would put an email address on the wire for every
 * screen that renders. Two narrow routes beat one that grew.
 *
 * There is no id parameter: it returns the caller's own row and nothing else.
 * `image` is re-validated against the avatar host allowlist on the way out,
 * so a URL written before that rule existed cannot be served now.
 */
export async function GET() {
  try {
    const userId = await requireUserId();
    const identity = await getUserIdentity(userId);
    return Response.json(identity);
  } catch (err) {
    return errorResponse(err);
  }
}
