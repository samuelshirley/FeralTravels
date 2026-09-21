import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { oauthProviderKeys } from '@/server/db/schema';

/**
 * The persisted last-known-good JWKS per OAuth provider — see
 * `src/server/auth/jwksSource.ts` for why it exists and how stale it may be
 * before it stops counting.
 */

export interface PersistedJwks {
  jwks: { keys: Record<string, unknown>[] };
  fetchedAt: Date;
}

export async function loadProviderJwks(provider: string): Promise<PersistedJwks | null> {
  const [row] = await db
    .select({ jwks: oauthProviderKeys.jwks, fetchedAt: oauthProviderKeys.fetchedAt })
    .from(oauthProviderKeys)
    .where(eq(oauthProviderKeys.provider, provider))
    .limit(1);
  return row ?? null;
}

/**
 * Upsert, but only forwards in time: two instances that fetched at different
 * moments can finish their writes in either order, and the older set must not
 * overwrite the newer one.
 */
export async function saveProviderJwks(provider: string, value: PersistedJwks): Promise<void> {
  await db
    .insert(oauthProviderKeys)
    .values({ provider, jwks: value.jwks, fetchedAt: value.fetchedAt })
    .onConflictDoUpdate({
      target: oauthProviderKeys.provider,
      set: { jwks: sql`excluded.jwks`, fetchedAt: sql`excluded.fetched_at` },
      setWhere: sql`excluded.fetched_at > ${oauthProviderKeys.fetchedAt}`,
    });
}
