/**
 * STRUCTURAL: the Apple provider Auth.js actually runs carries OUR discovery
 * fetch after `parseProviders` has merged it (issue #44).
 *
 * Both ways this breaks look green everywhere else:
 *  - passing `[customFetch]` in `Apple({ ... })`'s options: `providers.js:29`
 *    is `normalized[customFetch] ??= userOptions[customFetch]`, the provider's
 *    built-in wins, and the option vanishes without a warning;
 *  - importing `customFetch` from '@auth/core': that resolves to the top-level
 *    0.41.2 copy, a DIFFERENT `Symbol("custom-fetch")` from the one the nested
 *    0.37.2 copy under next-auth reads, so the override sits on a key nobody
 *    looks at.
 *
 * So this test captures the config `index.ts` really hands `NextAuth`, runs it
 * through the RUNTIME's own `parseProviders`, and compares identities against
 * the RUNTIME's own symbol — imported by path from the copy next-auth loads,
 * not from anywhere this repo's source imports it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as o from 'oauth4webapi';

const captured = vi.hoisted(() => {
  process.env.AUTH_APPLE_ID = 'com.example.web';
  process.env.AUTH_APPLE_SECRET = 'test-secret';
  return { config: null as null | { providers: unknown[] } };
});

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {} }));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
vi.mock('@/server/payments', () => ({
  claimPromoOnSignIn: async () => {},
  syncCompedFlagOnSignIn: async () => {},
}));
vi.mock('./admin', () => ({ syncAdminFlagOnSignIn: async () => {} }));
vi.mock('./sessionStore', () => ({
  assertSessionStoreReachable: async () => {},
  readSessionCookie: async () => null,
}));
vi.mock('next-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-auth')>();
  return {
    ...actual,
    default: (config: { providers: unknown[] }) => {
      captured.config = config;
      return { handlers: {}, auth: async () => null, signIn: async () => {}, signOut: async () => {} };
    },
  };
});

import { customFetch as nextAuthCustomFetch } from 'next-auth';
// The runtime's copies, by path: these are what Auth.js itself executes.
import parseProviders from '../../../node_modules/next-auth/node_modules/@auth/core/lib/utils/providers.js';
import { customFetch as runtimeCustomFetch } from '../../../node_modules/next-auth/node_modules/@auth/core/lib/symbols.js';
import { appleDiscoveryFetch } from './appleDiscovery';
import './index';

type Provider = { id: string; [key: symbol]: unknown };

function mergedApple(): Provider {
  expect(captured.config, 'index.ts never called NextAuth').not.toBeNull();
  const { providers } = parseProviders({
    providerId: 'apple',
    config: { providers: captured.config!.providers, basePath: '/api/auth' },
    url: new URL('https://feraltravels.test/api/auth'),
  } as Parameters<typeof parseProviders>[0]) as unknown as { providers: Provider[] };
  const apple = providers.find((p) => p.id === 'apple');
  expect(apple, 'no apple provider registered although AUTH_APPLE_ID/SECRET are set').toBeDefined();
  return apple!;
}

describe('web Sign in with Apple discovery', () => {
  it("imports the customFetch symbol the runtime reads (next-auth's, not top-level @auth/core's)", () => {
    expect(nextAuthCustomFetch).toBe(runtimeCustomFetch);
  });

  it('the merged Apple provider carries appleDiscoveryFetch, not the built-in override', () => {
    expect(mergedApple()[runtimeCustomFetch]).toBe(appleDiscoveryFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("survives Apple's empty-body 404, driven the way authorization-url.js drives discovery", async () => {
    // lib/actions/signin/authorization-url.js:18 and callback.js:38, verbatim
    // in shape: oauth4webapi's discoveryRequest with the provider's customFetch,
    // then processDiscoveryResponse. Before issue #44 this threw
    // `SyntaxError: Unexpected end of JSON input` on the first 404.
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) return new Response(null, { status: 404 });
      return Response.json({
        issuer: 'https://appleid.apple.com',
        authorization_endpoint: 'https://appleid.apple.com/auth/authorize',
        token_endpoint: 'https://appleid.apple.com/auth/token',
      });
    });
    const provider = mergedApple() as Provider & { issuer: string };
    const issuer = new URL(provider.issuer);
    const response = await o.discoveryRequest(issuer, {
      [o.customFetch]: provider[runtimeCustomFetch] as typeof fetch,
      [o.allowInsecureRequests]: true,
    });
    const as = await o.processDiscoveryResponse(issuer, response);
    expect(as.userinfo_endpoint).toBe('https://appleid.apple.com/fake_endpoint');
    expect(calls).toEqual([
      'https://appleid.apple.com/.well-known/openid-configuration',
      'https://appleid.apple.com/.well-known/openid-configuration',
    ]);
  });
});
