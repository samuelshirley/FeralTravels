import 'server-only';
import { eq, and, isNotNull } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { users } from '@/server/db/schema';

/**
 * Hardcoded list of admin email addresses. THIS is the source of truth.
 *
 * Changing this requires a code deploy — the env var `ADMIN_EMAILS` can only
 * narrow this set further, never expand it. Even if someone steals an env var
 * value or sets an arbitrary one in Vercel, they cannot become admin without
 * also being on this list.
 */
const ADMIN_ALLOWLIST: ReadonlyArray<string> = [
  'samuelashirley@gmail.com',
] as const;

const ALLOWLIST_SET = new Set(ADMIN_ALLOWLIST.map((e) => e.toLowerCase()));

function envAllowSet(): Set<string> {
  const raw = process.env.ADMIN_EMAILS;
  if (!raw) return ALLOWLIST_SET; // unset = use full hardcoded list
  const set = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  return set;
}

/**
 * Recipients for operational admin alert emails (e.g. data-source rate-limit
 * warnings). The hardcoded allowlist is the source of truth — same set that can
 * reach /admin.
 */
export function adminAlertRecipients(): string[] {
  return [...ADMIN_ALLOWLIST];
}

/** True if the email is in the hardcoded allowlist (case-insensitive). */
export function isOnAdminAllowlist(email: string | null | undefined): boolean {
  if (!email) return false;
  return ALLOWLIST_SET.has(email.toLowerCase());
}

/**
 * The single source of truth for whether a session principal is an admin.
 * Requires ALL of:
 *   1. email present and on the hardcoded `ADMIN_ALLOWLIST`
 *   2. email also permitted by `ADMIN_EMAILS` env (defaults to the full list)
 *   3. matching DB user row exists with `emailVerified IS NOT NULL` AND `is_admin = TRUE`
 *
 * Step 3 means a magic-link sign-in attempt to an admin address still has to
 * complete email verification, AND the silent flag set in the signIn event
 * must be present. We never trust the session token's email field by itself.
 */
export async function isAdminEmail(email: string | null | undefined): Promise<boolean> {
  if (!isOnAdminAllowlist(email)) return false;
  if (!envAllowSet().has(email!.toLowerCase())) return false;
  const row = await db
    .select({ id: users.id, isAdmin: users.isAdmin })
    .from(users)
    .where(and(eq(users.email, email!.toLowerCase()), isNotNull(users.emailVerified)))
    .limit(1);
  if (row.length === 0) return false;
  return row[0].isAdmin === true;
}

/**
 * Idempotent — call inside the Auth.js `signIn` event for every successful
 * sign-in. If the email is on the hardcoded allowlist we silently flip the
 * `is_admin` flag on the user row (so privilege follows the verified email,
 * not the env var or the session cookie).
 *
 * If the email is NOT on the allowlist we explicitly clear the flag, so even
 * if a row was tampered with manually it gets reset on next sign-in.
 */
export async function syncAdminFlagOnSignIn(email: string | null | undefined): Promise<void> {
  if (!email) return;
  const normalized = email.toLowerCase();
  const shouldBeAdmin = ALLOWLIST_SET.has(normalized);
  await db
    .update(users)
    .set({ isAdmin: shouldBeAdmin })
    .where(eq(users.email, normalized));
}
