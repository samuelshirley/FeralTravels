import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// Same reason as oauthIdentity.test.ts: the module is server-only, and the
// marker package throws outside a React Server Component.
vi.mock('server-only', () => ({}));

import { consumeIdToken, hashIdToken, type ReplayDeps } from './oauthReplay';
import { HttpError, UnauthorizedError } from './errors';

/**
 * The replay guard is the whole reason PR #7 touched auth at all: verifying a
 * provider ID token proves it is authentic, never that it is fresh, and a
 * captured token was good for unlimited 30-day sessions until it expired.
 *
 * These tests deliberately do NOT hit a database. Every property worth pinning
 * here is about the ORDER of the two calls consumeIdToken makes and what it
 * does with their answers — a real Postgres would test drizzle, not this.
 * The one thing a fake cannot prove is that the ON CONFLICT target really is
 * the primary key; that is asserted by the shape of the default dep and by the
 * migration, and is called out below where it matters.
 *
 * Thresholds are written as literals on purpose. Reading them from the module
 * would make the test agree with whatever the module says, which is not a test.
 */

const TOKEN = 'header.payload.signature';
const EMAIL = 'driver@example.com';
const EXPIRES = new Date('2026-08-20T12:00:00.000Z');

/** A fake store with the same uniqueness guarantee the primary key gives us. */
function fakeStore(initial: string[] = []) {
  const seen = new Set(initial);
  const claimTokenHash: NonNullable<ReplayDeps['claimTokenHash']> = async ({ tokenHash }) => {
    if (seen.has(tokenHash)) return false;
    seen.add(tokenHash);
    return true;
  };
  return { seen, claimTokenHash };
}

describe('hashIdToken', () => {
  it('is a stable sha256 hex digest', () => {
    expect(hashIdToken(TOKEN)).toBe(hashIdToken(TOKEN));
    expect(hashIdToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never contains the token itself', () => {
    // The table records which tokens were spent; it must not be a place to
    // steal a still-live bearer credential from.
    const digest = hashIdToken(TOKEN);
    expect(digest).not.toContain(TOKEN);
    expect(digest).not.toContain('payload');
  });

  it('separates tokens that differ by one character', () => {
    expect(hashIdToken(TOKEN)).not.toBe(hashIdToken(`${TOKEN}x`));
  });
});

describe('consumeIdToken', () => {
  it('resolves the first time a token is presented', async () => {
    const { claimTokenHash } = fakeStore();
    await expect(
      consumeIdToken(TOKEN, EMAIL, EXPIRES, { claimTokenHash, countRecentUses: async () => 1 })
    ).resolves.toBeUndefined();
  });

  it('rejects the second use of the same token with TokenAlreadyUsed', async () => {
    const { claimTokenHash } = fakeStore();
    const deps = { claimTokenHash, countRecentUses: async () => 1 };

    await consumeIdToken(TOKEN, EMAIL, EXPIRES, deps);

    await expect(consumeIdToken(TOKEN, EMAIL, EXPIRES, deps)).rejects.toThrow(UnauthorizedError);
    await expect(consumeIdToken(TOKEN, EMAIL, EXPIRES, deps)).rejects.toThrow('TokenAlreadyUsed');
  });

  it('replay is 401, not 500 — the app maps the code to real copy', async () => {
    const { claimTokenHash } = fakeStore([hashIdToken(TOKEN)]);
    const err = await consumeIdToken(TOKEN, EMAIL, EXPIRES, {
      claimTokenHash,
      countRecentUses: async () => 1,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });

  it('a different token by the same user is unaffected by the first', async () => {
    const { claimTokenHash } = fakeStore();
    const deps = { claimTokenHash, countRecentUses: async () => 2 };

    await consumeIdToken(TOKEN, EMAIL, EXPIRES, deps);
    await expect(
      consumeIdToken('a.different.token', EMAIL, EXPIRES, deps)
    ).resolves.toBeUndefined();
  });

  it('lets exactly one of two concurrent redemptions through', async () => {
    // The race this models is two requests carrying the SAME captured token,
    // landing on two serverless instances at once. Neither can see the other's
    // row, which is why the claim has to be an atomic insert and not a
    // check-then-act — and why the default dep uses ON CONFLICT DO NOTHING
    // against the primary key rather than a SELECT followed by an INSERT.
    const { claimTokenHash } = fakeStore();
    const deps = { claimTokenHash, countRecentUses: async () => 1 };

    const results = await Promise.allSettled([
      consumeIdToken(TOKEN, EMAIL, EXPIRES, deps),
      consumeIdToken(TOKEN, EMAIL, EXPIRES, deps),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(UnauthorizedError);
    expect((rejected.reason as Error).message).toBe('TokenAlreadyUsed');
  });

  it('claims the token BEFORE counting — a replay costs nothing to refuse', async () => {
    const calls: string[] = [];
    const { claimTokenHash } = fakeStore([hashIdToken(TOKEN)]);

    await consumeIdToken(TOKEN, EMAIL, EXPIRES, {
      claimTokenHash: async (row) => {
        calls.push('claim');
        return claimTokenHash(row);
      },
      countRecentUses: async () => {
        calls.push('count');
        return 1;
      },
    }).catch(() => {});

    // Not just "claim came first" — the count must not run at all, or a flood
    // of replayed tokens would still cost a query each.
    expect(calls).toEqual(['claim']);
  });

  it('runs the count only after a successful claim', async () => {
    const calls: string[] = [];
    const { claimTokenHash } = fakeStore();

    await consumeIdToken(TOKEN, EMAIL, EXPIRES, {
      claimTokenHash: async (row) => {
        calls.push('claim');
        return claimTokenHash(row);
      },
      countRecentUses: async () => {
        calls.push('count');
        return 1;
      },
    });

    expect(calls).toEqual(['claim', 'count']);
  });

  it('allows the fifth exchange in the window', async () => {
    const { claimTokenHash } = fakeStore();
    await expect(
      consumeIdToken(TOKEN, EMAIL, EXPIRES, { claimTokenHash, countRecentUses: async () => 5 })
    ).resolves.toBeUndefined();
  });

  it('refuses the sixth with 429 RateLimited', async () => {
    const { claimTokenHash } = fakeStore();
    const err = await consumeIdToken(TOKEN, EMAIL, EXPIRES, {
      claimTokenHash,
      countRecentUses: async () => 6,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).message).toBe('RateLimited');
  });

  it('still consumes a token it then rate-limits', async () => {
    // Documented and deliberate: a caller hammering the endpoint does not get
    // its token back. Pinned because it looks like a bug to a future reader.
    const { seen, claimTokenHash } = fakeStore();

    await consumeIdToken(TOKEN, EMAIL, EXPIRES, {
      claimTokenHash,
      countRecentUses: async () => 99,
    }).catch(() => {});

    expect(seen.has(hashIdToken(TOKEN))).toBe(true);
  });

  it('counts over a 60-second window ending now', async () => {
    const now = Date.parse('2026-08-20T12:00:00.000Z');
    const countRecentUses = vi.fn<NonNullable<ReplayDeps['countRecentUses']>>(async () => 1);
    const { claimTokenHash } = fakeStore();

    await consumeIdToken(TOKEN, EMAIL, EXPIRES, {
      claimTokenHash,
      countRecentUses,
      now: () => now,
    });

    const since = countRecentUses.mock.calls[0]![1];
    expect(now - since.getTime()).toBe(60_000);
  });

  it('normalises the address before claiming or counting', async () => {
    // users.email is not guaranteed lowercase (the NextAuth adapter writes the
    // provider's value verbatim), so a per-address limit keyed on the raw
    // string would be trivially sidestepped by changing the capitalisation.
    const claimTokenHash = vi.fn<NonNullable<ReplayDeps['claimTokenHash']>>(async () => true);
    const countRecentUses = vi.fn<NonNullable<ReplayDeps['countRecentUses']>>(async () => 1);

    await consumeIdToken(TOKEN, '  Driver@Example.COM  ', EXPIRES, {
      claimTokenHash,
      countRecentUses,
    });

    expect(claimTokenHash.mock.calls[0]![0]).toMatchObject({ email: EMAIL });
    expect(countRecentUses.mock.calls[0]![0]).toBe(EMAIL);
  });

  it('records the token’s own expiry, not a fixed TTL', async () => {
    // The row exists to stop a replay, so it has to outlive the token by
    // exactly as long as the token can still be verified — no more.
    const claimTokenHash = vi.fn<NonNullable<ReplayDeps['claimTokenHash']>>(async () => true);

    await consumeIdToken(TOKEN, EMAIL, EXPIRES, {
      claimTokenHash,
      countRecentUses: async () => 1,
    });

    expect(claimTokenHash.mock.calls[0]![0]).toMatchObject({ expires: EXPIRES });
  });

  it('stores the hash, never the token', async () => {
    const claimTokenHash = vi.fn<NonNullable<ReplayDeps['claimTokenHash']>>(async () => true);

    await consumeIdToken(TOKEN, EMAIL, EXPIRES, {
      claimTokenHash,
      countRecentUses: async () => 1,
    });

    const row = claimTokenHash.mock.calls[0]![0];
    expect(row.tokenHash).toBe(hashIdToken(TOKEN));
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });
});

/**
 * The one thing the fake above cannot prove.
 *
 * Every behavioural test in this file models single-use with a `Set`, which
 * assumes the real INSERT races on a UNIQUE constraint. If someone pointed
 * `onConflictDoNothing` at a non-unique column — or the migration stopped
 * declaring `token_hash` as the primary key — a second redemption would
 * silently INSERT a second row, return it, and mint a second session. Every
 * test above would still be green.
 *
 * Three files have to agree, so all three are asserted: the query, the Drizzle
 * schema, and the SQL that actually ran against production.
 */
describe('single use rests on a real unique constraint', () => {
  const ROOT = process.cwd();
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

  it('the insert conflicts on the token hash', () => {
    const source = read('src/server/auth/oauthReplay.ts');
    expect(source).toMatch(/onConflictDoNothing\(\{\s*target:\s*oauthTokenUses\.tokenHash\s*\}\)/);
    // …and returns something, or `inserted.length > 0` is always false and
    // every exchange looks like a replay.
    expect(source).toMatch(/\.returning\(/);
  });

  it('the schema declares that column the primary key', () => {
    const source = read('src/server/db/schema.ts');
    expect(source).toMatch(/tokenHash:\s*text\('token_hash'\)\.primaryKey\(\)/);
  });

  it('the migration that ran against prod declares it too', () => {
    // The schema file is what Drizzle generates FROM; this is what Postgres
    // was actually told. They can drift if a migration is hand-edited.
    const sql = read('drizzle/0023_oauth_token_uses.sql');
    expect(sql).toMatch(/"token_hash"\s+text\s+PRIMARY KEY/i);
  });
});
