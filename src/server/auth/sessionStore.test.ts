import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * The cookie jar and the database are the two things this module reads, so
 * both are the test's inputs. `next/headers` is mocked rather than stubbed
 * globally because `cookies()` also has to be able to THROW — that is the
 * out-of-request-scope branch, and it is the one that must not become an error
 * screen.
 */
const cookieStore = { get: vi.fn() };
let cookiesThrows = false;
vi.mock('next/headers', () => ({
  cookies: async () => {
    if (cookiesThrows) throw new Error('called outside a request scope');
    return cookieStore;
  },
}));

const limit = vi.fn();
vi.mock('@/server/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
  },
}));

import { readSessionCookie, assertSessionStoreReachable } from './sessionStore';
import { SessionStoreUnavailableError } from './errors';
import { SESSION_COOKIE_NAME, SECURE_SESSION_COOKIE_NAME } from '@/lib/sessionCookie';

beforeEach(() => {
  cookiesThrows = false;
  cookieStore.get.mockReset();
  limit.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('readSessionCookie', () => {
  it('finds the plain cookie (http — local dev, next start over localhost)', async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === SESSION_COOKIE_NAME ? { value: 'tok-plain' } : undefined,
    );
    expect(await readSessionCookie()).toBe('tok-plain');
  });

  it('finds the __Secure- cookie (https — every deployed environment)', async () => {
    cookieStore.get.mockImplementation((name: string) =>
      name === SECURE_SESSION_COOKIE_NAME ? { value: 'tok-secure' } : undefined,
    );
    expect(await readSessionCookie()).toBe('tok-secure');
  });

  it('is null when there is no session cookie at all', async () => {
    cookieStore.get.mockReturnValue(undefined);
    expect(await readSessionCookie()).toBeNull();
  });

  it('is null — not a throw — when called outside a request scope', async () => {
    cookiesThrows = true;
    await expect(readSessionCookie()).resolves.toBeNull();
  });
});

describe('assertSessionStoreReachable', () => {
  it('returns quietly when the store answers — the session is genuinely gone', async () => {
    limit.mockResolvedValue([]);
    await expect(assertSessionStoreReachable('tok')).resolves.toBeUndefined();
  });

  it('returns quietly when the row is still there', async () => {
    limit.mockResolvedValue([{ sessionToken: 'tok' }]);
    await expect(assertSessionStoreReachable('tok')).resolves.toBeUndefined();
  });

  /**
   * The case the whole change exists for: on 2026-09-08 this threw
   * `password authentication failed for user 'neondb_owner'` and the app
   * answered by sending a signed-in user to /login.
   */
  it('throws SessionStoreUnavailableError when the query throws', async () => {
    limit.mockRejectedValue(new Error("password authentication failed for user 'neondb_owner'"));
    await expect(assertSessionStoreReachable('tok')).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });

  it('the thrown error is a 503 carrying the digest the error boundary reads', async () => {
    limit.mockRejectedValue(new Error('connection terminated'));
    const err = await assertSessionStoreReachable('tok').catch((e) => e);
    expect(err.status).toBe(503);
    // 401 would make mobile/lib/api.ts clear the keychain — see errors.ts.
    expect(err.status).not.toBe(401);
    expect(err.digest).toBe('SESSION_STORE_UNAVAILABLE');
  });
});
