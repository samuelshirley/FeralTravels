import 'server-only';
import { redirect } from 'next/navigation';
import { auth } from '@/server/auth';
import { isAdminEmail } from '@/server/auth/admin';
import { GET_THE_APP_PATH, webAppEnabled } from '@/lib/webAccess';
import { areTestEndpointsEnabled, isFixtureEmail } from '@/server/auth/test-endpoints';

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
  const email = session?.user?.email;

  if (await isAdminEmail(email)) return;

  /**
   * E2E fixture accounts keep web access on a deployment that has the test
   * endpoints armed.
   *
   * Found before this shipped, not after: `account-deletion.spec.ts` drives the
   * danger zone at the foot of /settings and `login-otp.spec.ts` asserts a real
   * delivered code lands the user on /trips. Both sign in as
   * `playwright-*@e2e.feraltravels.com`, neither is the admin, and with the web
   * off both would have been redirected to /get-the-app before their first
   * assertion — taking Apple guideline 5.1.1(v) coverage and the only proof of
   * real email delivery with them, on a preview that was supposed to be
   * proving the block WORKS.
   *
   * The scope is deliberately narrow and doubly gated. The address must match
   * `FIXTURE_EMAIL_PATTERN` — a subdomain with no MX record, so it can never
   * belong to a person — AND the deployment must have `E2E_TEST_ENDPOINTS=1`,
   * which `areTestEndpointsEnabled` refuses outright when
   * `VERCEL_ENV === 'production'`. Production cannot reach this branch even if
   * somebody registers the address.
   *
   * Same trade `/api/test/*` already makes, for the same reason: the
   * alternative is deleting the coverage.
   */
  if (areTestEndpointsEnabled() && email && isFixtureEmail(email)) return;

  redirect(GET_THE_APP_PATH);
}

/** Where a signed-out /admin visit lands: the existing sign-in form, which carries `callbackUrl` through /login/verify. */
export const ADMIN_SIGN_IN_PATH = `/login?callbackUrl=${encodeURIComponent('/admin')}`;

/**
 * The door for the one person allowed in.
 *
 * Found 2026-09-30: with the web off, `requireWebAccess()` sent a signed-out
 * visit to /admin to /get-the-app like any other page — and the download screen
 * has no sign-in. /login worked the whole time, but nothing pointed at it, so
 * the admin could only get in by knowing to type it.
 *
 * Called from `src/app/admin/layout.tsx`, which renders before any admin page,
 * so this redirect wins over the page's own in BOTH switch states.
 *
 * It asks one question — is anybody signed in — and nothing else. It does NOT
 * decide admin-ness and does NOT replace `requireWebAccess()`: every admin page
 * still runs that and `isAdmin` itself, so a signed-in non-admin still ends at
 * /get-the-app (web off) or /trips (web on). The sign-in form is reachable by
 * anyone at /login already; this grants nothing, it only stops hiding it.
 *
 * The strict `auth()`, which throws when the session store is down: an outage
 * is a 503, never a sign-out (see `docs/design/conventions.md`).
 */
export async function requireAdminSignIn(): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect(ADMIN_SIGN_IN_PATH);
}
