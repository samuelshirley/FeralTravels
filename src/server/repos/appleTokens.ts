import 'server-only';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { accounts } from '@/server/db/schema';
import { decryptSecret } from '@/server/deletedUserCrypto';

/**
 * Sign in with Apple refresh tokens, held so account deletion can revoke them
 * (App Review 5.1.1(v)). See `src/server/auth/appleTokens.ts` for the Apple
 * side and `src/server/deleteAccount.ts` for the revoke.
 *
 * Stored in `accounts` — the Auth.js adapter's table — as a native row:
 * `{ provider: 'apple', providerAccountId: <Apple sub>, type: 'oidc' }`. The
 * row cascades away with the user, and its presence is what labels the
 * deletion tombstone 'apple' rather than 'native-oauth'.
 *
 * `refresh_token` here is ALWAYS ciphertext (`encryptSecret`, v1 AES-256-GCM
 * under DELETED_USER_ENC_KEY). The caller encrypts; this module never sees a
 * plaintext token going in.
 */

const APPLE = 'apple';

/**
 * Upsert on the (provider, providerAccountId) primary key. An Apple `sub`
 * that reappears under a different user — the account was deleted and the
 * same Apple ID signed up again — moves to the new user with its new token.
 */
export async function storeAppleRefreshToken(
  userId: string,
  sub: string,
  encryptedRefreshToken: string
): Promise<void> {
  await db
    .insert(accounts)
    .values({
      userId,
      type: 'oidc',
      provider: APPLE,
      providerAccountId: sub,
      refresh_token: encryptedRefreshToken,
    })
    .onConflictDoUpdate({
      target: [accounts.provider, accounts.providerAccountId],
      set: { userId, refresh_token: encryptedRefreshToken },
    });
}

export interface AppleRefreshTokens {
  /** Decrypted, ready to revoke. Never log these. */
  tokens: string[];
  /**
   * Rows holding a token that would not decrypt — the key is missing or was
   * rotated, or the row was written by something else. They cannot be
   * revoked, and the caller reports how many.
   */
  undecryptable: number;
}

/** Every stored Apple refresh token for the user. Throws only if the database does. */
export async function getAppleRefreshTokens(userId: string): Promise<AppleRefreshTokens> {
  const rows = await db
    .select({ refreshToken: accounts.refresh_token })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.provider, APPLE), isNotNull(accounts.refresh_token))
    );

  const tokens: string[] = [];
  let undecryptable = 0;
  for (const row of rows) {
    const token = decryptSecret(row.refreshToken);
    if (token) tokens.push(token);
    else undecryptable += 1;
  }
  return { tokens, undecryptable };
}
