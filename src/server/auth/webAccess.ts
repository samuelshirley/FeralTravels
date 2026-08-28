import 'server-only';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdminEmail } from '@/server/auth/admin';
import { GET_THE_APP_PATH, webAppEnabled } from '@/lib/webAccess';

/**
 * The Node half of the web-off gate: the part that needs a database.
 *
 * Middleware turns away browsers with no session, but it runs on the edge and
 * a cookie is all it can see — it cannot tell the admin's session from anyone
 * else's. So every authenticated page calls this, where `isAdminEmail` can do
 * what it always does: check the hardcoded allowlist, the env narrowing, AND a
 * verified `is_admin` row. Three conditions, none of them an email string
 * compared at the edge.
 *
 * Deliberately a redirect and not a 403: the person on the other end is a user
 * who typed the address out of habit, and the honest answer to them is "the app
 * is on your phone", not an error.
 */
export async function requireWebAccess(): Promise<void> {
  if (webAppEnabled()) return;
  const session = await auth();
  if (await isAdminEmail(session?.user?.email)) return;
  redirect(GET_THE_APP_PATH);
}
