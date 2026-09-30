import { requireAdminSignIn } from '@/server/auth/webAccess';

export const dynamic = 'force-dynamic';

/**
 * A signed-out visit to any /admin page lands on the sign-in form, not the
 * download screen — see `requireAdminSignIn`. Nothing else lives here: each
 * page still gates itself with `requireWebAccess()` + `isAdmin`.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminSignIn();
  return children;
}
