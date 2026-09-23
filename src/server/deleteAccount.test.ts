/**
 * Account deletion revokes Sign in with Apple (App Review 5.1.1(v)) — in the
 * right order, and without a revoke failure ever un-deleting anybody.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { deleteAccount, type DeleteAccountDeps } from './deleteAccount';
import type { AccountDeletionSummary } from '@/server/repos/accountDeletion';
import type { AppleRefreshTokens } from '@/server/repos/appleTokens';

const SUMMARY: AccountDeletionSummary = {
  tripCount: 2,
  vehicleCount: 1,
  chatMessageCount: 9,
  signInProviders: ['apple'],
};

function harness(opts: {
  stored?: AppleRefreshTokens;
  readTokens?: DeleteAccountDeps['readTokens'];
  deleteUser?: DeleteAccountDeps['deleteUser'];
  revoke?: DeleteAccountDeps['revoke'];
  logFailure?: DeleteAccountDeps['logFailure'];
}) {
  const order: string[] = [];
  const logged: string[] = [];
  const lines: string[] = [];
  const deps: DeleteAccountDeps = {
    readTokens:
      opts.readTokens ??
      (async () => {
        order.push('read');
        return opts.stored ?? { tokens: [], undecryptable: 0 };
      }),
    deleteUser: async (userId, deletedBy) => {
      order.push(`delete:${userId}:${deletedBy}`);
      return opts.deleteUser ? opts.deleteUser(userId, deletedBy) : SUMMARY;
    },
    revoke: async (token) => {
      order.push(`revoke:${token}`);
      return opts.revoke ? opts.revoke(token) : { ok: true };
    },
    logFailure:
      opts.logFailure ??
      (async (m) => {
        logged.push(m);
      }),
    log: (line) => lines.push(line),
  };
  return { deps, order, logged, lines };
}

describe('deleteAccount', () => {
  it('reads the Apple tokens before the delete and revokes them after it', async () => {
    const h = harness({ stored: { tokens: ['r.one', 'r.two'], undecryptable: 0 } });
    await expect(deleteAccount('u1', 'self', h.deps)).resolves.toEqual(SUMMARY);
    expect(h.order).toEqual(['read', 'delete:u1:self', 'revoke:r.one', 'revoke:r.two']);
    expect(h.logged).toEqual([]);
    expect(h.lines).toEqual(['[account-deletion] appleRevoked=revoked tokens=2']);
  });

  it('returns the deletion result when Apple refuses, and logs it as apple:revoke', async () => {
    const h = harness({
      stored: { tokens: ['r.one'], undecryptable: 0 },
      revoke: async () => ({ ok: false, reason: 'unavailable', detail: 'http 404, http 404, http 404' }),
    });
    await expect(deleteAccount('u1', 'self', h.deps)).resolves.toEqual(SUMMARY);
    expect(h.logged).toEqual(['revoke failed (unavailable): http 404, http 404, http 404']);
    expect(h.lines).toEqual(['[account-deletion] appleRevoked=failed tokens=1']);
  });

  it('survives a revoke that throws, and a log write that fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = harness({
        stored: { tokens: ['r.one'], undecryptable: 0 },
        revoke: async () => {
          throw new Error('r.one leaked into a message');
        },
        logFailure: async () => {
          throw new Error('db down');
        },
      });
      await expect(deleteAccount('u1', 'self', h.deps)).resolves.toEqual(SUMMARY);
      expect(err).toHaveBeenCalled();
      expect(JSON.stringify(err.mock.calls)).not.toContain('r.one');
    } finally {
      err.mockRestore();
    }
  });

  it('logs "not configured" — the state until the key is on Vercel — without failing', async () => {
    const h = harness({
      stored: { tokens: ['r.one'], undecryptable: 0 },
      revoke: async () => ({
        ok: false,
        reason: 'not_configured',
        detail: 'not configured: APPLE_SIGNIN_KEY_ID unset',
      }),
    });
    await expect(deleteAccount('u1', 'self', h.deps)).resolves.toEqual(SUMMARY);
    expect(h.logged).toEqual(['revoke failed (not_configured): not configured: APPLE_SIGNIN_KEY_ID unset']);
  });

  it('reports rows that would not decrypt, since they cannot be revoked', async () => {
    const h = harness({ stored: { tokens: [], undecryptable: 2 } });
    await expect(deleteAccount('u1', 'self', h.deps)).resolves.toEqual(SUMMARY);
    expect(h.order).toEqual(['read', 'delete:u1:self']);
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]).toMatch(/^2 stored Apple token\(s\) could not be decrypted/);
  });

  it('never revokes when the delete itself fails — the account still exists', async () => {
    const h = harness({
      stored: { tokens: ['r.one'], undecryptable: 0 },
      deleteUser: async () => {
        throw new Error('transaction aborted');
      },
    });
    await expect(deleteAccount('u1', 'self', h.deps)).rejects.toThrow('transaction aborted');
    expect(h.order).toEqual(['read', 'delete:u1:self']);
    expect(h.logged).toEqual([]);
  });

  it('lets a database failure reading the tokens propagate, and deletes nothing', async () => {
    // The route hands this to errorResponse like any failed delete: a 5xx, never a 401.
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const h = harness({
      readTokens: async () => {
        throw down;
      },
    });
    await expect(deleteAccount('u1', 'self', h.deps)).rejects.toBe(down);
    expect(h.order).toEqual([]);
  });

  it('is a no-op for a user with no Apple rows: no revoke, no log', async () => {
    const h = harness({});
    await expect(deleteAccount('u1', 'admin', h.deps)).resolves.toEqual(SUMMARY);
    expect(h.order).toEqual(['read', 'delete:u1:admin']);
    expect(h.logged).toEqual([]);
    expect(h.lines).toEqual([]);
  });
});
