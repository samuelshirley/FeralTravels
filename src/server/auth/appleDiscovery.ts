import 'server-only';
import { ATTEMPT_TIMEOUT_MS, LIVE_BUDGET_MS, RETRY_DELAYS_MS } from './jwksSource';

/**
 * The web Sign in with Apple flow's discovery fetch, with retries and a cache.
 *
 * THE GAP (issue #44). Auth.js's Apple provider ships its own `[customFetch]`
 * (`@auth/core/providers/apple.js`, 0.37.2 as nested under next-auth). For
 * `.well-known/openid-configuration` it calls `response.clone().json()` with no
 * status check, so an empty-body 404 — what Apple served on `/auth/keys` at
 * ~20% on 2026-09-21 — throws `SyntaxError: Unexpected end of JSON input`, and
 * nothing retries. Discovery is fetched TWICE per sign-in (the authorization
 * URL, then the callback), so each attempt had two chances to fail.
 *
 * THE CONTRACT this replaces, read from the built-in rather than guessed:
 *  - only a URL whose path ends in `.well-known/openid-configuration` is
 *    intercepted; every other request goes to `fetch` untouched;
 *  - the discovery document comes back with `userinfo_endpoint` set to
 *    `APPLE_FAKE_USERINFO_ENDPOINT`. Apple has no userinfo endpoint, and
 *    `lib/actions/callback/oauth/callback.js:45` throws without one, so
 *    dropping it breaks web Apple sign-in outright.
 *
 * THE RETRY POLICY is `jwksSource.ts`'s, imported rather than restated: the
 * same Apple front end, the same failure shape (a 404 chosen per request by a
 * bad backend, no benefit from a fresh connection), and the same caller — a
 * person waiting on a sign-in. What was measured there applies here.
 *
 * THE CACHE. A document fetched less than `DISCOVERY_FRESH_MS` ago is served
 * without asking Apple, which takes the callback's second fetch off the
 * failure surface entirely. If every live attempt fails, an older document is
 * still served: it is what Apple really published, it carries no key material,
 * and Apple's endpoints have not moved in years.
 *
 * DELIBERATELY NOT PERSISTED to the database, unlike the JWKS. The JWKS is
 * needed to verify a token and a cold instance must have one; discovery only
 * locates endpoints, a failure affects only a sign-in already in flight, and
 * the retry window is ~4s. The person can press the button again. A table for
 * this would be complexity with no failure it prevents.
 */

export const APPLE_FAKE_USERINFO_ENDPOINT = 'https://appleid.apple.com/fake_endpoint';

/** Long enough that one sign-in's two fetches share an answer; short enough to notice a change the same day. */
export const DISCOVERY_FRESH_MS = 60 * 60_000;

/** Every live attempt failed and no earlier document was held. */
export class DiscoveryUnavailableError extends Error {
  constructor(readonly upstream: string) {
    super(`apple discovery unavailable: ${upstream}`);
    this.name = 'DiscoveryUnavailableError';
  }
}

export interface AppleDiscoveryDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

type DiscoveryDocument = Record<string, unknown> & { token_endpoint: string };

interface Cached {
  doc: DiscoveryDocument;
  fetchedAt: number;
}

function isDiscoveryDocument(value: unknown): value is DiscoveryDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { token_endpoint?: unknown }).token_endpoint === 'string'
  );
}

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const code =
    (err as { cause?: { code?: unknown } } | null)?.cause?.code ??
    (err as { code?: unknown } | null)?.code;
  return `network ${String(code ?? name)}`;
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

/** A `[customFetch]` for the Apple provider. Exported as a factory so tests own the clock. */
export function createAppleDiscoveryFetch(deps: AppleDiscoveryDeps = {}): typeof fetch {
  // Looked up per call, not captured: whatever `fetch` is global when the
  // request is made (Next patches it at startup) is the one used.
  const doFetch: typeof fetch = deps.fetch ?? ((...args) => fetch(...args));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((line: string) => console.error(line));

  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<DiscoveryDocument>>();

  async function attempt(
    url: string,
    timeoutMs: number
  ): Promise<{ doc: DiscoveryDocument } | { failure: string }> {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        // Next's fetch cache must never hand back, or store, one of Apple's 404s.
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { failure: describeError(err) };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { failure: `http ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { failure: 'invalid json' };
    }
    return isDiscoveryDocument(body) ? { doc: body } : { failure: 'not a discovery document' };
  }

  async function fetchLive(url: string): Promise<DiscoveryDocument> {
    const started = now();
    const failures: string[] = [];
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      if (i > 0) {
        const pause = RETRY_DELAYS_MS[i - 1] * (0.5 + Math.random());
        if (now() - started + pause >= LIVE_BUDGET_MS) break;
        await sleep(pause);
      }
      const remaining = LIVE_BUDGET_MS - (now() - started);
      if (remaining <= 0) break;
      const result = await attempt(url, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
      if ('doc' in result) {
        cache.set(url, { doc: result.doc, fetchedAt: now() });
        if (failures.length > 0) {
          log(`[oauth] apple discovery: fetched on attempt ${i + 1} after ${failures.join(', ')}`);
        }
        return result.doc;
      }
      failures.push(result.failure);
    }

    const held = cache.get(url);
    if (held) {
      const ageMin = ((now() - held.fetchedAt) / 60_000).toFixed(0);
      log(`[oauth] apple discovery: live fetch failed: ${failures.join(', ')}; using the document fetched ${ageMin}m ago`);
      return held.doc;
    }
    throw new DiscoveryUnavailableError(failures.join(', '));
  }

  async function discovery(url: string): Promise<DiscoveryDocument> {
    const held = cache.get(url);
    if (held && now() - held.fetchedAt < DISCOVERY_FRESH_MS) return held.doc;
    // Concurrent sign-ins on one instance share a single live fetch.
    let pending = inflight.get(url);
    if (!pending) {
      pending = fetchLive(url).finally(() => inflight.delete(url));
      inflight.set(url, pending);
    }
    return pending;
  }

  return async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const url = requestUrl(args[0]);
    if (!url.pathname.endsWith('.well-known/openid-configuration')) return doFetch(...args);
    const doc = await discovery(url.href);
    return Response.json({ ...doc, userinfo_endpoint: APPLE_FAKE_USERINFO_ENDPOINT });
  };
}

/** The instance the Apple provider uses; its cache lives as long as the server instance. */
export const appleDiscoveryFetch = createAppleDiscoveryFetch();
