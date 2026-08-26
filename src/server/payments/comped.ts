import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { users } from '@/server/db/schema';
import { FIXTURE_EMAIL_PATTERN } from '@/server/auth/test-endpoints';

/**
 * Accounts that are free forever.
 *
 * This follows the `ADMIN_ALLOWLIST` precedent in `src/server/auth/admin.ts`
 * exactly, including its comment — *"Mirrors admin allowlist at sign-in; never
 * infer admin from email alone."* The flag lives on `users.comped` and is set
 * from this list at sign-in. Nothing in the paywall path ever compares an
 * email, because an entitlement check that string-matches is one typo away
 * from comping every address at a domain.
 */
const COMPED_ALLOWLIST: ReadonlyArray<string> = ['samuelashirley@gmail.com'] as const;

const COMPED_SET = new Set(COMPED_ALLOWLIST.map((e) => e.toLowerCase()));

/**
 * True for the author's account and for E2E fixture addresses.
 *
 * The fixture pattern is `playwright-<runid>-<n>@e2e.feraltravels.com`, reused
 * from `test-endpoints.ts` rather than restated, so the two can never drift.
 * `e2e.` has no MX record, so those addresses can never belong to a person —
 * comping them grants nothing to anybody real. Without this, every Playwright
 * run would hit the paywall on day 7 of the fixture's fake age and the suite
 * would fail for reasons that have nothing to do with the code under test.
 */
export function isCompedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return COMPED_SET.has(normalized) || FIXTURE_EMAIL_PATTERN.test(normalized);
}

/**
 * Idempotent — called from the Auth.js `signIn` and `createUser` events beside
 * `syncAdminFlagOnSignIn`. Sets the flag when the address qualifies and
 * explicitly CLEARS it when it does not, so a row edited by hand resets itself
 * on the next sign-in rather than staying free forever.
 */
export async function syncCompedFlagOnSignIn(email: string | null | undefined): Promise<void> {
  if (!email) return;
  const normalized = email.trim().toLowerCase();
  await db.update(users).set({ comped: isCompedEmail(normalized) }).where(eq(users.email, normalized));
}
