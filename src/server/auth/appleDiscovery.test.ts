/**
 * The web Apple provider's discovery fetch (issue #44): retries, cache, and the
 * contract of the built-in override it replaces. `appleProvider.test.ts` proves
 * Auth.js actually runs this function; this file proves what it does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processDiscoveryResponse } from 'oauth4webapi';

vi.mock('server-only', () => ({}));

import Apple from 'next-auth/providers/apple';
import { customFetch } from 'next-auth';
import {
  APPLE_FAKE_USERINFO_ENDPOINT,
  createAppleDiscoveryFetch,
  DISCOVERY_FRESH_MS,
  DiscoveryUnavailableError,
} from './appleDiscovery';

const DISCOVERY = 'https://appleid.apple.com/.well-known/openid-configuration';
const T0 = Date.parse('2026-09-22T12:00:00Z');

/** Trimmed from Apple's live document, 2026-09-22. */
const APPLE_DOC = {
  issuer: 'https://appleid.apple.com',
  authorization_endpoint: 'https://appleid.apple.com/auth/authorize',
  token_endpoint: 'https://appleid.apple.com/auth/token',
  revocation_endpoint: 'https://appleid.apple.com/auth/revoke',
  jwks_uri: 'https://appleid.apple.com/auth/keys',
  response_types_supported: ['code'],
  subject_types_supported: ['pairwise'],
  id_token_signing_alg_values_supported: ['RS256'],
};

type Step = number | 'timeout' | 'network' | 'malformed' | Record<string, unknown>;

/** Plays back `script` — one step per call, then repeats the last. */
function scriptedFetch(script: Step[]) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(input instanceof Request ? input.url : String(input));
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    if (step === 'network') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    if (step === 'malformed') return new Response('{"issuer":', { status: 200 });
    // The 2026-09-21 failure shape exactly: a 404 with an EMPTY body.
    if (typeof step === 'number') return new Response(null, { status: step });
    return Response.json(step);
  }) as typeof fetch;
  return { impl, calls };
}

function harness(script: Step[], clock = { t: T0 }) {
  const { impl, calls } = scriptedFetch(script);
  const logs: string[] = [];
  const f = createAppleDiscoveryFetch({
    fetch: impl,
    now: () => clock.t,
    sleep: async () => {},
    log: (line) => logs.push(line),
  });
  return { f, calls, logs, clock };
}

describe('Apple discovery: retry', () => {
  it('an empty-body 404 then a 200 succeeds', async () => {
    const { f, calls, logs } = harness([404, APPLE_DOC]);
    const res = await f(DISCOVERY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token_endpoint: APPLE_DOC.token_endpoint });
    expect(calls).toHaveLength(2);
    expect(logs.join('\n')).toContain('fetched on attempt 2 after http 404');
  });

  it('survives a run of failures of every kind within the retry budget', async () => {
    // A literal script, not derived from RETRY_DELAYS_MS: shrinking the retry
    // schedule must fail this test, not quietly shrink it too.
    const { f, calls } = harness([404, 'timeout', 'network', 'malformed', APPLE_DOC]);
    await expect(f(DISCOVERY)).resolves.toHaveProperty('status', 200);
    expect(calls).toHaveLength(5);
  });

  it('malformed JSON on a 200 is retried, not thrown', async () => {
    const { f, calls, logs } = harness(['malformed', APPLE_DOC]);
    await expect(f(DISCOVERY)).resolves.toHaveProperty('status', 200);
    expect(calls).toHaveLength(2);
    expect(logs.join('\n')).toContain('after invalid json');
  });

  it('a 200 that is not a discovery document is retried', async () => {
    const { f, calls } = harness([{ error: 'maintenance' }, APPLE_DOC]);
    await expect(f(DISCOVERY)).resolves.toHaveProperty('status', 200);
    expect(calls).toHaveLength(2);
  });

  it('every attempt a 404: a clear error naming each failure, not a SyntaxError', async () => {
    const { f, calls } = harness([404]);
    const err = await f(DISCOVERY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscoveryUnavailableError);
    expect((err as Error).message).toBe(
      'apple discovery unavailable: http 404, http 404, http 404, http 404, http 404'
    );
    expect(calls).toHaveLength(5);
  });
});

describe("Apple discovery: the built-in override's contract", () => {
  it('injects userinfo_endpoint and keeps every field Apple sent', async () => {
    const { f } = harness([APPLE_DOC]);
    const body = await (await f(DISCOVERY)).json();
    expect(body).toEqual({ ...APPLE_DOC, userinfo_endpoint: APPLE_FAKE_USERINFO_ENDPOINT });
  });

  it('the response passes the same oauth4webapi check Auth.js runs on it', async () => {
    // Status, content-type and issuer are all checked there; a Response that
    // failed any of them would break sign-in as surely as the 404 did.
    const { f } = harness([APPLE_DOC]);
    const as = await processDiscoveryResponse(new URL('https://appleid.apple.com'), await f(DISCOVERY));
    expect(as.userinfo_endpoint).toBe(APPLE_FAKE_USERINFO_ENDPOINT);
    expect(as.token_endpoint).toBe(APPLE_DOC.token_endpoint);
  });

  it('matches the userinfo_endpoint the built-in injects', async () => {
    // Read from the installed provider, so a next-auth bump that changes the
    // value fails here instead of in production.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json(APPLE_DOC)) as typeof fetch;
    try {
      const builtIn = Apple({ clientId: 'c', clientSecret: 's' })[customFetch] as typeof fetch;
      const body = await (await builtIn(DISCOVERY)).json();
      expect(body.userinfo_endpoint).toBe(APPLE_FAKE_USERINFO_ENDPOINT);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('passes a non-discovery request straight through, arguments and response untouched', async () => {
    const tokenResponse = new Response('{"error":"invalid_grant"}', { status: 400 });
    const seen: unknown[][] = [];
    const f = createAppleDiscoveryFetch({
      fetch: (async (...args: unknown[]) => {
        seen.push(args);
        return tokenResponse;
      }) as typeof fetch,
    });
    const init = { method: 'POST', body: 'grant_type=authorization_code' };
    const res = await f('https://appleid.apple.com/auth/token', init);
    expect(res).toBe(tokenResponse);
    expect(seen).toEqual([['https://appleid.apple.com/auth/token', init]]);
    expect(seen[0][1]).toBe(init);
  });

  it('intercepts discovery when it arrives as a Request, like the built-in', async () => {
    const { f, calls } = harness([APPLE_DOC]);
    const body = await (await f(new Request(DISCOVERY))).json();
    expect(body.userinfo_endpoint).toBe(APPLE_FAKE_USERINFO_ENDPOINT);
    expect(calls).toEqual([DISCOVERY]);
  });
});

describe('Apple discovery: cache', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("the callback's second fetch is served from memory", async () => {
    const { f, calls, clock } = harness([APPLE_DOC, 404]);
    await f(DISCOVERY);
    clock.t += 90_000; // the person spends a minute and a half on Apple's page
    const res = await f(DISCOVERY);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('refetches once the document is older than DISCOVERY_FRESH_MS', async () => {
    const { f, calls, clock } = harness([APPLE_DOC]);
    await f(DISCOVERY);
    clock.t += DISCOVERY_FRESH_MS;
    await f(DISCOVERY);
    expect(calls).toHaveLength(2);
  });

  it('a dead live fetch falls back to the document already held', async () => {
    const { f, calls, logs, clock } = harness([APPLE_DOC, 404]);
    await f(DISCOVERY);
    clock.t += DISCOVERY_FRESH_MS + 1;
    const body = await (await f(DISCOVERY)).json();
    expect(body.token_endpoint).toBe(APPLE_DOC.token_endpoint);
    expect(calls).toHaveLength(6);
    expect(logs.join('\n')).toContain('using the document fetched 60m ago');
  });

  it('concurrent sign-ins share one live fetch', async () => {
    const { f, calls } = harness([APPLE_DOC]);
    await Promise.all([f(DISCOVERY), f(DISCOVERY), f(DISCOVERY)]);
    expect(calls).toHaveLength(1);
  });

  it('a failed fetch is not cached: the next sign-in tries live again', async () => {
    const { f, calls } = harness([404, 404, 404, 404, 404, APPLE_DOC]);
    await expect(f(DISCOVERY)).rejects.toBeInstanceOf(DiscoveryUnavailableError);
    await expect(f(DISCOVERY)).resolves.toHaveProperty('status', 200);
    expect(calls).toHaveLength(6);
  });
});
