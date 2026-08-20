import { z } from 'zod';
import { requireUser, errorResponse } from '@/server/auth/guards';
import { ForbiddenError } from '@/server/auth/errors';
import { isOnAdminAllowlist } from '@/server/auth/admin';
import { deleteUserAccount } from '@/server/repos/accountDeletion';
import { DELETE_CONFIRM_PHRASE, isDeleteConfirmationValid } from '@/lib/accountDeletion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Deliberately a POST with a body rather than `DELETE /api/me`.
 *
 * The confirmation phrase has to reach the server — checking it only in the UI
 * would mean a stray fetch, a replayed request or a bug in a single component
 * could erase an account with no intent behind it. Bodies on DELETE requests are
 * legal but inconsistently preserved by intermediaries, and this is the one
 * request in the app that must never half-work.
 */
const bodySchema = z.object({
  /**
   * Compared case-insensitively after trimming. The typing gesture is there to
   * force a deliberate pause, not to test the user's shift key.
   *
   * Deliberately NOT `.min(1)`: an empty string is a *failed confirmation*, not
   * a malformed request, and it should come back as the same clear 403 the user
   * gets for typing the wrong words — never as a 500 with a raw Zod message.
   */
  confirm: z.string().max(64).optional(),
});

/**
 * Any unparseable body — no body at all, not JSON, wrong shape — is treated as
 * "you did not confirm". There is no request malformed enough that the right
 * answer is to delete the account anyway, so every failure funnels to the same
 * refusal.
 */
async function readConfirm(req: Request): Promise<string | undefined> {
  try {
    return bodySchema.parse(await req.json()).confirm;
  } catch {
    return undefined;
  }
}

/**
 * Permanently delete the signed-in user's account.
 *
 * Serves BOTH clients from one route: `requireUser` resolves a NextAuth session
 * cookie (web) and an `Authorization: Bearer` token (the iOS app) against the
 * same sessions table, so there is one implementation and one place for this to
 * be wrong. That matters here — App Store guideline 5.1.1(v) requires the app
 * itself to offer deletion, and a second native-only code path would be a second
 * chance to leak data.
 *
 * Every session row belonging to the user cascades away with the user row, so
 * the caller's own credential is dead the moment this returns. Clients still
 * clear their local state (cookie / keychain) so the UI doesn't sit on a token
 * it will only ever get a 401 from.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const confirm = await readConfirm(req);

    if (!isDeleteConfirmationValid(confirm)) {
      throw new ForbiddenError(`Type "${DELETE_CONFIRM_PHRASE}" to confirm.`);
    }

    /**
     * The admin account is blocked from deleting itself IN PRODUCTION ONLY.
     *
     * The allowlist in `server/auth/admin.ts` is hardcoded to one address, so
     * deleting it in prod would take the admin dashboard, the error log and the
     * ops alert recipient with it, and nothing in the app could undo that. On
     * previews the guard is off on purpose, so the full flow — including an
     * admin's own account — can be exercised against the PR's throwaway
     * database before it ships.
     */
    if (process.env.VERCEL_ENV === 'production' && isOnAdminAllowlist(user.email)) {
      throw new ForbiddenError(
        'The admin account cannot be deleted from the app. Remove it from the allowlist first.'
      );
    }

    const summary = await deleteUserAccount(user.id, 'self');

    return Response.json({ ok: true, deleted: summary });
  } catch (err) {
    return errorResponse(err);
  }
}
