import 'server-only';
import type { AccountDeletionSummary } from '@/server/repos/accountDeletion';
import type { AppleRefreshTokens } from '@/server/repos/appleTokens';
import type { AppleRevokeResult } from '@/server/auth/appleTokens';

/**
 * Delete an account — the ONLY way to, outside tests.
 *
 * `deleteUserAccount` (the transaction) erases the data; this wraps it with
 * the one thing that has to happen outside the database: revoking the user's
 * Sign in with Apple tokens, which App Review 5.1.1(v) requires of an app that
 * offers Sign in with Apple. `src/lib/appleRevokeGuard.test.ts` fails the
 * suite if anything else calls `deleteUserAccount` or this stops revoking.
 *
 * THE ORDER IS THE CONTRACT:
 *  1. Read the stored Apple tokens FIRST — the `accounts` rows holding them
 *     cascade away with the user. A database failure here propagates to the
 *     route's `errorResponse` exactly as a failing delete always has — a 5xx,
 *     never a 401 (which would clear the iOS keychain).
 *  2. Delete. If the transaction throws, nothing is revoked: the account
 *     still exists and is still signed in with Apple.
 *  3. Revoke each token. A failure — Apple refusing, Apple unreachable, the
 *     key not configured, a row that would not decrypt — is logged to
 *     /admin/errors as `apple:revoke` and does NOT fail the request. The user
 *     asked to be deleted and has been; an error now would tell them
 *     otherwise, and a retry would find no account.
 */

export interface DeleteAccountDeps {
  readTokens?: (userId: string) => Promise<AppleRefreshTokens>;
  deleteUser?: (userId: string, deletedBy: 'self' | 'admin') => Promise<AccountDeletionSummary>;
  revoke?: (token: string) => Promise<AppleRevokeResult>;
  logFailure?: (errorMessage: string) => Promise<void>;
  log?: (line: string) => void;
}

/** Lazy, so the unit tests can inject every dependency without loading the database client. */
const defaults: Required<DeleteAccountDeps> = {
  readTokens: async (userId) => {
    const { getAppleRefreshTokens } = await import('@/server/repos/appleTokens');
    return getAppleRefreshTokens(userId);
  },
  deleteUser: async (userId, deletedBy) => {
    const { deleteUserAccount } = await import('@/server/repos/accountDeletion');
    return deleteUserAccount(userId, deletedBy);
  },
  revoke: async (token) => {
    const { revokeRefreshToken } = await import('@/server/auth/appleTokens');
    return revokeRefreshToken(token);
  },
  logFailure: async (errorMessage) => {
    const { logUsageEvent } = await import('@/server/repos/usage');
    // userId null: the user row is gone, and usage_events.user_id is a
    // foreign key to it.
    await logUsageEvent({ userId: null, provider: 'apple:revoke', success: false, errorMessage });
  },
  log: (line) => console.log(line),
};

export async function deleteAccount(
  userId: string,
  deletedBy: 'self' | 'admin',
  deps: DeleteAccountDeps = {}
): Promise<AccountDeletionSummary> {
  const d = { ...defaults, ...deps };

  const stored = await d.readTokens(userId);
  const summary = await d.deleteUser(userId, deletedBy);

  const failures: string[] = [];
  if (stored.undecryptable > 0) {
    failures.push(
      `${stored.undecryptable} stored Apple token(s) could not be decrypted (DELETED_USER_ENC_KEY missing or rotated); not revoked`
    );
  }
  for (const token of stored.tokens) {
    let result: AppleRevokeResult;
    try {
      result = await d.revoke(token);
    } catch (err) {
      result = {
        ok: false,
        reason: 'unavailable',
        detail: `revoke threw ${err instanceof Error ? err.name : typeof err}`,
      };
    }
    if (!result.ok) failures.push(`revoke failed (${result.reason}): ${result.detail}`);
  }

  for (const message of failures) {
    await d
      .logFailure(message.slice(0, 500))
      .catch((e) =>
        console.error('[account-deletion] failed to log apple:revoke failure to usage_events:', e instanceof Error ? e.name : e)
      );
  }

  const attempted = stored.tokens.length + stored.undecryptable;
  const outcome = attempted === 0 ? 'none' : failures.length === 0 ? 'revoked' : 'failed';
  // Server log only; the response shape is unchanged.
  if (outcome !== 'none') d.log(`[account-deletion] appleRevoked=${outcome} tokens=${attempted}`);

  return summary;
}
