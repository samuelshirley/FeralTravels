import 'server-only';

/**
 * ONE address whose six-digit code is fixed, for App Store review only.
 *
 * App Store Connect's **Sign-In Information** form wants a username and a
 * password. This app has neither — it is passwordless — so there was nothing to
 * put in the field, and `docs/design/ios-review-notes.md` §1 argued (correctly,
 * at the time) that Sign in with Apple is the right answer to guideline 2.1(a)
 * and that a fixed code should be built ONLY if a reviewer rejected anyway.
 *
 * This is that fallback. §1 has been rewritten to describe what now exists,
 * including the condition for deleting it again.
 *
 * ── The shape, and why each part of it is narrow ────────────────────────────
 *
 * The whole defence is that there is nothing here to widen:
 *
 *   - The address is ONE hardcoded string. Not a pattern, not a list, not an
 *     env var. Changing which account this applies to takes a code review and a
 *     deploy — the same reasoning as `ADMIN_ALLOWLIST` and
 *     `FIXTURE_EMAIL_PATTERN`, both of which are hardcoded for this reason: a
 *     guard you can widen from a dashboard is not a guard.
 *   - The code is a hardcoded literal too, so no environment can choose a
 *     different one.
 *   - `APPLE_REVIEW_SIGNIN` can only turn the whole thing OFF. It is consulted
 *     as a strict `=== '1'`, and it selects nothing: with it unset or set to
 *     anything else, this address behaves exactly like every other address in
 *     the system and `000000` is simply a wrong code.
 *
 * That last point is what makes it operable: the account can be switched off
 * from the Vercel dashboard the moment review finishes, with no deploy.
 *
 * ── What this account is NOT ────────────────────────────────────────────────
 *
 *   - NOT on `ADMIN_ALLOWLIST` (`server/auth/admin.ts`).
 *   - NOT comped (`server/payments/comped.ts`). It lands in the ordinary
 *     seven-day trial, so the reviewer can reach Settings → Plan → View plans
 *     and complete a sandbox purchase. Comping it would recreate the exact
 *     rejection §2 of the review notes is about — an entitled account has no
 *     paywall, and for a while that meant no screen in the app showed a price.
 *   - NOT related to `FIXTURE_EMAIL_PATTERN` or the `/api/test/*` endpoints.
 *     Those are hard-off on production with no override and stay that way; this
 *     is deliberately a separate mechanism on a separate domain, because they
 *     exist for opposite environments.
 *
 * It is an ordinary account in every other respect: a real `users` row, a real
 * session, the real paywall, the real deletion flow.
 */

// Same shape `test-endpoints.ts` uses, and for the same reason: an interface
// naming only the one key has no properties in common with `ProcessEnv`, so
// `env: EnvLike = process.env` does not typecheck.
type EnvLike = Record<string, string | undefined>;

/**
 * The single address this applies to.
 *
 * On `feraltravels.com`, a domain we control, so this can never be claimed by
 * a stranger — unlike a public-namespace address, which is the distinction
 * `internalAccounts.ts` draws for the same reason.
 */
export const REVIEW_ACCOUNT_EMAIL = 'appletest@feraltravels.com';

/** The fixed code. Hardcoded: no environment may choose a different one. */
export const REVIEW_ACCOUNT_CODE = '000000';

/** True only for the review address, and only while the flag is armed. */
export function isReviewAccountSignIn(
  email: string | null | undefined,
  env: EnvLike = process.env,
): boolean {
  if (!isReviewSignInArmed(env)) return false;
  return isReviewAccountEmail(email);
}

/**
 * The address test on its own, WITHOUT the flag.
 *
 * Separate because the two callers that exempt this address from a gate — the
 * send ladder and the sign-up breaker — must only do so when the feature is
 * armed, and reading the flag in one place keeps that honest. Exported so the
 * guard can prove the address comparison is case-insensitive and exact.
 */
export function isReviewAccountEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  // Case-insensitive and trimmed, matching the rest of the auth surface:
  // every address in this system is normalised this way before it is stored
  // or compared, so `Appletest@…` must be the same account as `appletest@…`.
  // Exact equality, never `includes`/`startsWith`/`endsWith` — a substring
  // test would accept `appletest@feraltravels.com.evil.com`.
  return email.trim().toLowerCase() === REVIEW_ACCOUNT_EMAIL;
}

/** Whether the kill switch is armed. Only ever turns the feature OFF. */
export function isReviewSignInArmed(env: EnvLike = process.env): boolean {
  return env.APPLE_REVIEW_SIGNIN === '1';
}
