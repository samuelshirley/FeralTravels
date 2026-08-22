import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { oauthTokenUses } from '@/server/db/schema';
import { HttpError, UnauthorizedError } from './errors';

/**
 * Single-use + rate limiting for native OAuth ID tokens.
 *
 * Why this exists: verifying a provider token proves the token is authentic,
 * NOT that this is the first time we've seen it. Google and Apple ID tokens
 * are valid for around an hour, the iOS client id ships inside the app binary
 * (so it is not a secret), and iOS custom URL schemes are not exclusive to one
 * app. Without a record of what has been redeemed, one captured token was good
 * for unlimited 30-day sessions until it expired.
 *
 * Deliberately DB-backed rather than an in-memory Map: every request may hit a
 * different serverless instance, so a process-local counter enforces nothing.
 * Same reasoning as the OTP resend cooldown, which is also a table read.
 *
 * NOT a substitute for nonce binding. A nonce would stop a token OBTAINED by
 * another app from being usable here at all; this only stops the SAME token
 * being spent twice. Nonce binding needs a server-issued challenge and a
 * matching change in the Expo client, so it is tracked separately.
 */

/** Exchanges allowed per address per window before the route starts refusing. */
const MAX_EXCHANGES_PER_WINDOW = 5;
const WINDOW_MS = 60_000;

/**
 * SHA-256, never the token itself. The raw JWT is a live bearer credential
 * until it expires; a table that records which ones were used has no business
 * being a place to steal them from.
 */
export function hashIdToken(idToken: string): string {
  return createHash('sha256').update(idToken).digest('hex');
}

/**
 * Deps seam, same shape and same reason as `VerifyDeps` in oauthIdentity.ts:
 * the two properties worth testing here — that a replay loses, and that the
 * INSERT happens before the count — are properties of the ORDER of these two
 * calls, not of the SQL. Injecting them lets the test drive both concurrently
 * and assert the ordering without a database.
 *
 * Production never passes this. The defaults below are the only implementation
 * that ships.
 */
export interface ReplayDeps {
  /**
   * Record the hash. Resolves `true` only for the call that actually inserted
   * the row — a conflict (someone got there first) resolves `false`.
   */
  claimTokenHash?: (row: { tokenHash: string; email: string; expires: Date }) => Promise<boolean>;
  /** How many exchanges this address has made since `since`. */
  countRecentUses?: (email: string, since: Date) => Promise<number>;
  /** Injectable clock so the window boundary is testable. */
  now?: () => number;
}

const defaultClaimTokenHash: NonNullable<ReplayDeps['claimTokenHash']> = async (row) => {
  const inserted = await db
    .insert(oauthTokenUses)
    .values(row)
    .onConflictDoNothing({ target: oauthTokenUses.tokenHash })
    .returning({ tokenHash: oauthTokenUses.tokenHash });
  return inserted.length > 0;
};

const defaultCountRecentUses: NonNullable<ReplayDeps['countRecentUses']> = async (email, since) => {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(oauthTokenUses)
    .where(and(eq(oauthTokenUses.email, email), gt(oauthTokenUses.usedAt, since)));
  return count;
};

/**
 * Claim this token. Returns normally exactly once per token.
 *
 * Order matters: the INSERT goes first so that two concurrent requests racing
 * with the same token cannot both pass — the loser hits the primary key and is
 * rejected by the database, not by a check-then-act window. The rate-limit
 * count runs afterwards, which means a refused-for-rate-limit token is still
 * consumed. That is intentional: a caller hammering the endpoint should not
 * get its token back.
 *
 * @throws UnauthorizedError('TokenAlreadyUsed') on replay
 * @throws HttpError(429, 'RateLimited') when the address is over the window
 */
export async function consumeIdToken(
  idToken: string,
  email: string,
  expiresAt: Date,
  deps: ReplayDeps = {}
): Promise<void> {
  const tokenHash = hashIdToken(idToken);
  const normalized = email.trim().toLowerCase();

  const claimed = await (deps.claimTokenHash ?? defaultClaimTokenHash)({
    tokenHash,
    email: normalized,
    expires: expiresAt,
  });

  if (!claimed) {
    throw new UnauthorizedError('TokenAlreadyUsed');
  }

  const since = new Date((deps.now ?? Date.now)() - WINDOW_MS);
  const count = await (deps.countRecentUses ?? defaultCountRecentUses)(normalized, since);

  if (count > MAX_EXCHANGES_PER_WINDOW) {
    throw new HttpError(429, 'RateLimited');
  }
}

/**
 * Drop rows for tokens that are past their own expiry — they can no longer be
 * replayed because verification would reject them first, so the record has no
 * remaining value. Best-effort and fire-and-forget: a failure here must never
 * turn a successful sign-in into an error.
 */
export async function pruneExpiredTokenUses(): Promise<void> {
  await db.delete(oauthTokenUses).where(lt(oauthTokenUses.expires, new Date()));
}
