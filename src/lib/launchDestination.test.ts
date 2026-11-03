import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunchDestination, type LaunchDestinationDeps } from './launchDestination';

/**
 * Every combination the launch gate can meet: token or not, intro seen or
 * not, and — with a token — blocked, not blocked, a lookup that throws, and a
 * lookup that never answers. The intro must be reachable from exactly one of
 * them: no token AND not seen.
 */
function deps(over: {
  token: boolean;
  seen: boolean;
  blocked?: () => Promise<string | null>;
  timeoutMs?: number;
}) {
  const calls: string[] = [];
  const d: LaunchDestinationDeps = {
    hasToken: async () => {
      calls.push('token');
      return over.token;
    },
    introSeen: async () => {
      calls.push('introSeen');
      return over.seen;
    },
    blockedDestination: async () => {
      calls.push('blocked');
      return over.blocked ? over.blocked() : null;
    },
    blockedTimeoutMs: over.timeoutMs ?? 2500,
  };
  return { d, calls };
}

afterEach(() => vi.useRealTimers());

describe('resolveLaunchDestination', () => {
  it('fresh install (no token, intro not seen) -> /intro, and asks nothing of the server', async () => {
    const { d, calls } = deps({ token: false, seen: false });
    expect(await resolveLaunchDestination(d)).toBe('/intro');
    expect(calls).not.toContain('blocked');
  });

  it('signed out after the intro (no token, seen) -> /sign-in', async () => {
    const { d, calls } = deps({ token: false, seen: true });
    expect(await resolveLaunchDestination(d)).toBe('/sign-in');
    expect(calls).not.toContain('blocked');
  });

  for (const seen of [false, true]) {
    it(`signed in, not blocked, intro seen=${seen} -> /trips (the flag is not even read)`, async () => {
      const { d, calls } = deps({ token: true, seen });
      expect(await resolveLaunchDestination(d)).toBe('/trips');
      expect(calls).not.toContain('introSeen');
    });

    it(`signed in, blocked with a trip, intro seen=${seen} -> that trip's chat`, async () => {
      const { d, calls } = deps({ token: true, seen, blocked: async () => '/trips/abc?chat=1' });
      expect(await resolveLaunchDestination(d)).toBe('/trips/abc?chat=1');
      expect(calls).not.toContain('introSeen');
    });

    it(`signed in, blocked with no trips, intro seen=${seen} -> /paywall`, async () => {
      const { d } = deps({ token: true, seen, blocked: async () => '/paywall' });
      expect(await resolveLaunchDestination(d)).toBe('/paywall');
    });

    it(`signed in, lookup throws, intro seen=${seen} -> /trips (treated as entitled)`, async () => {
      const { d } = deps({
        token: true,
        seen,
        blocked: async () => {
          throw new Error('offline');
        },
      });
      expect(await resolveLaunchDestination(d)).toBe('/trips');
    });

    it(`signed in, lookup never answers, intro seen=${seen} -> /trips after the timeout`, async () => {
      vi.useFakeTimers();
      const { d } = deps({ token: true, seen, blocked: () => new Promise<string | null>(() => {}), timeoutMs: 2500 });
      const route = resolveLaunchDestination(d);
      await vi.advanceTimersByTimeAsync(2499);
      let settled = false;
      void route.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await route).toBe('/trips');
    });
  }

  it('a blocked answer that arrives before the timeout wins over /trips', async () => {
    vi.useFakeTimers();
    const { d } = deps({
      token: true,
      seen: false,
      blocked: () => new Promise((r) => setTimeout(() => r('/paywall'), 1000)),
    });
    const route = resolveLaunchDestination(d);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await route).toBe('/paywall');
  });
});
