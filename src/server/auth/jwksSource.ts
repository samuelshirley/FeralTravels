import 'server-only';
import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';

/**
 * Where the native OAuth exchange gets the provider's public keys from.
 *
 * THE INCIDENT. On 2026-09-21 Apple's `https://appleid.apple.com/auth/keys`
 * answered `404` with an empty body to roughly one request in five, and real
 * Sign in with Apple attempts failed in production with `ERR_JOSE_GENERIC` —
 * jose's error for "the JWKS response was not a 200". The token was never
 * examined. The module this replaces used jose's `createRemoteJWKSet`, which
 * made ONE fetch per cold start and, worse, one more every ten minutes on a
 * warm instance: once its cache ages past `cacheMaxAge`, a failed reload throws
 * even though the previous keys are still in memory. Every cold start was one
 * unlucky fetch away from refusing a real person.
 *
 * WHAT THIS DOES, in order, all before the token is looked at:
 *
 *  1. A set fetched less than `MEMORY_FRESH_MS` ago (by this instance, or by
 *     another one and persisted) is used as-is.
 *  2. Otherwise fetch live, retrying on any non-200, timeout, network error or
 *     malformed body — see `RETRY_DELAYS_MS` for why spacing, not fresh
 *     connections. A success is persisted to `oauth_provider_keys`.
 *  3. If every attempt fails, fall back to the newest set we hold (memory or
 *     database) as long as it is younger than `MAX_STALE_MS`.
 *  4. If there is no such set, throw `KeysUnavailableError` — which the caller
 *     turns into 503 `ProviderUnavailable`, NOT 401 `InvalidToken`, because at
 *     this point nothing is known about the token at all.
 *
 * SIGNATURE CHECKING IS NEVER RELAXED. A fallback set is a set of public keys
 * the provider really did publish; a token still has to verify against one of
 * them. The only thing a stale set can do is fail CLOSED: a token signed with
 * a key the provider rotated in since then has no matching key, and the
 * rotation refresh below either fetches it or the token is refused.
 *
 * Why not jose's `jwksCache` option, which exists to export/import a set: it
 * only seeds a cache it considers fresh, and once that cache ages out jose's
 * reload still throws on a failed fetch with the old keys in hand. There is no
 * hook for "fall back to what you had". Owning the source is less code than
 * bending that one.
 */

export type JwksProvider = 'google' | 'apple';

export interface StoredJwks {
  jwks: JSONWebKeySet;
  fetchedAt: Date;
}

/** Persistence seam; production uses `src/server/repos/oauthJwks.ts`. */
export interface JwksStore {
  load(provider: JwksProvider): Promise<StoredJwks | null>;
  save(provider: JwksProvider, value: StoredJwks): Promise<void>;
}

/**
 * Within this age a set is used without asking the provider — jose's own
 * default `cacheMaxAge`, so a warm instance asks exactly as often as before.
 */
export const MEMORY_FRESH_MS = 10 * 60_000;

/**
 * The oldest set a failed live fetch may fall back to: 72 hours.
 *
 * What the bound protects against is not rotation — a stale set fails closed
 * on a new key, see above — but WITHDRAWAL: a provider that pulls a key
 * because it leaked. Every successful live fetch replaces the fallback, so a
 * withdrawn key can only keep verifying while we have been unable to reach
 * the provider for the whole time since it was pulled. 72 hours rides out a
 * weekend-long provider incident; it is short enough that a withdrawn key
 * stops being honoured within three days even if we never reach the provider
 * again. Apple rotates its signing keys rarely, and Google publishes a new key
 * well before signing with it and keeps the old one listed for days, so
 * neither provider's normal rotation comes near this.
 */
export const MAX_STALE_MS = 72 * 60 * 60_000;

/**
 * Pauses BETWEEN live attempts, so five attempts in all, spread over roughly
 * four seconds (each pause is jittered ±50%).
 *
 * Measured 2026-09-21 16:13–16:19 UTC, against Apple's three published
 * addresses: the 404s came at ~19–28% on EVERY address, at the same rate on a
 * single reused keep-alive socket (Apple answered 404 and then 200 on the same
 * connection) as on a fresh connection per request, and a 404 did not make the
 * next back-to-back request more likely to fail (P(404 | previous 404) ≈ 21–25%,
 * the unconditional rate). So a fresh connection escapes nothing — the bad
 * backend is behind Apple's front end, chosen per request — and the retry
 * reuses whatever connection `fetch` hands it. The attempts are SPACED rather
 * than back-to-back because the same failure measured from a Vercel function
 * earlier that day was burstier than independence allows (3 of 25 cold starts
 * needed a 4th attempt, against <1% expected), which a laptop could not
 * reproduce. The persisted set covers whatever still gets through.
 */
export const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

/** One attempt's ceiling — jose's default was 5s; a hung attempt is cut sooner. */
export const ATTEMPT_TIMEOUT_MS = 3000;

/** The whole live fetch, retries included, never keeps a sign-in waiting longer. */
export const LIVE_BUDGET_MS = 9000;

/**
 * After a live fetch fails and a fallback carried the request, the next
 * requests use the fallback straight away for this long instead of each
 * paying for another four seconds of retries during the same outage. Only
 * when a fallback exists: with none, every request tries live, because the
 * alternative is refusing sign-ins that a retry might have saved.
 *
 * Also the minimum gap between rotation refreshes (an unknown `kid`), so a
 * caller spraying made-up key ids cannot turn this route into a request pump
 * against the provider — the same 30s jose's `cooldownDuration` used.
 */
export const LIVE_COOLDOWN_MS = 30_000;

/** No usable key set at all. Carries what the upstream said, for the log. */
export class KeysUnavailableError extends Error {
  constructor(
    readonly provider: JwksProvider,
    readonly upstream: string
  ) {
    super(`${provider} keys unavailable: ${upstream}`);
    this.name = 'KeysUnavailableError';
  }
}

/** Every live attempt failed. Internal: the caller sees a fallback or `KeysUnavailableError`. */
class LiveFetchFailed extends Error {
  constructor(readonly attempts: string[]) {
    super(attempts.join(', '));
    this.name = 'LiveFetchFailed';
  }
}

export interface KeySourceDeps {
  fetch?: typeof fetch;
  store?: JwksStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface KeySource {
  /**
   * A key resolver for `jwtVerify`, obtained BEFORE the token is examined.
   * @throws KeysUnavailableError when no usable key set can be had.
   */
  keys(): Promise<JWTVerifyGetKey>;
}

interface LoadedSet {
  jwks: JSONWebKeySet;
  fetchedAt: number;
  local: JWTVerifyGetKey;
}

function isJwks(value: unknown): value is JSONWebKeySet {
  if (typeof value !== 'object' || value === null) return false;
  const keys = (value as { keys?: unknown }).keys;
  return (
    Array.isArray(keys) &&
    keys.length > 0 &&
    keys.every((k) => typeof k === 'object' && k !== null && !Array.isArray(k))
  );
}

/** A set jose will accept, or null. Never throws. */
function loadSet(jwks: unknown, fetchedAt: number): LoadedSet | null {
  if (!isJwks(jwks)) return null;
  try {
    return { jwks, fetchedAt, local: createLocalJWKSet(jwks) };
  } catch {
    return null;
  }
}

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const code =
    (err as { cause?: { code?: unknown } } | null)?.cause?.code ??
    (err as { code?: unknown } | null)?.code;
  return `network ${String(code ?? name)}`;
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * The store is imported lazily so that importing this module (and
 * `oauthIdentity.ts`, whose unit tests inject their own store) does not pull
 * in the database client.
 */
const databaseStore: JwksStore = {
  async load(provider) {
    const { loadProviderJwks } = await import('@/server/repos/oauthJwks');
    const row = await loadProviderJwks(provider);
    return row && isJwks(row.jwks) ? { jwks: row.jwks, fetchedAt: row.fetchedAt } : null;
  },
  async save(provider, value) {
    const { saveProviderJwks } = await import('@/server/repos/oauthJwks');
    await saveProviderJwks(provider, {
      jwks: value.jwks as unknown as { keys: Record<string, unknown>[] },
      fetchedAt: value.fetchedAt,
    });
  },
};

export function createKeySource(
  provider: JwksProvider,
  url: string,
  deps: KeySourceDeps = {}
): KeySource {
  const doFetch = deps.fetch ?? fetch;
  const store = deps.store ?? databaseStore;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((line: string) => console.error(line));

  let memory: LoadedSet | null = null;
  let lastLiveAttemptAt = -Infinity;
  let lastLiveFailureAt = -Infinity;
  let inflight: Promise<LoadedSet> | null = null;

  // Returns the set when fresh, rather than acting as a type guard: a guard's
  // false branch would narrow `memory` to null for the fallback code below.
  const freshOrNull = (set: LoadedSet | null): LoadedSet | null =>
    set !== null && now() - set.fetchedAt < MEMORY_FRESH_MS ? set : null;

  async function attempt(timeoutMs: number): Promise<{ jwks: JSONWebKeySet } | { failure: string }> {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        // Explicit: Next's fetch cache must never hand back a stored answer
        // here, and must never store one of Apple's 404s either.
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
    return loadSet(body, 0) ? { jwks: body as JSONWebKeySet } : { failure: 'not a jwks' };
  }

  async function persist(set: LoadedSet): Promise<void> {
    // Awaited, not fire-and-forget: a serverless function can be frozen the
    // moment its response is sent, taking an unawaited write with it. A
    // failure is logged and never turns a verified sign-in into an error.
    try {
      await store.save(provider, { jwks: set.jwks, fetchedAt: new Date(set.fetchedAt) });
    } catch (err) {
      log(`[oauth] ${provider} jwks: could not persist the fetched set: ${describeError(err)}`);
    }
  }

  async function fetchLive(): Promise<LoadedSet> {
    const started = now();
    lastLiveAttemptAt = started;
    const failures: string[] = [];
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      if (i > 0) {
        const pause = RETRY_DELAYS_MS[i - 1] * (0.5 + Math.random());
        if (now() - started + pause >= LIVE_BUDGET_MS) break;
        await sleep(pause);
      }
      const remaining = LIVE_BUDGET_MS - (now() - started);
      if (remaining <= 0) break;
      const result = await attempt(Math.min(ATTEMPT_TIMEOUT_MS, remaining));
      if ('jwks' in result) {
        const set = loadSet(result.jwks, now()) as LoadedSet;
        memory = set;
        if (failures.length > 0) {
          log(`[oauth] ${provider} jwks: fetched on attempt ${i + 1} after ${failures.join(', ')}`);
        }
        await persist(set);
        return set;
      }
      failures.push(result.failure);
    }
    lastLiveFailureAt = now();
    throw new LiveFetchFailed(failures);
  }

  async function loadStored(): Promise<LoadedSet | null> {
    try {
      const stored = await store.load(provider);
      return stored ? loadSet(stored.jwks, stored.fetchedAt.getTime()) : null;
    } catch (err) {
      log(`[oauth] ${provider} jwks: could not read the persisted set: ${describeError(err)}`);
      return null;
    }
  }

  function unavailable(detail: string): KeysUnavailableError {
    const age = memory ? now() - memory.fetchedAt : null;
    const held =
      age === null
        ? 'no persisted set'
        : `persisted set ${hours(age)} old, past the ${hours(MAX_STALE_MS)} bound`;
    return new KeysUnavailableError(provider, `${detail}; ${held}`);
  }

  async function refresh(): Promise<LoadedSet> {
    // A set another instance fetched a few minutes ago is as good as one we
    // would fetch now, and costs the provider nothing.
    const stored = await loadStored();
    if (stored && (!memory || stored.fetchedAt > memory.fetchedAt)) memory = stored;
    const fresh = freshOrNull(memory);
    if (fresh) return fresh;

    const usable = memory && now() - memory.fetchedAt < MAX_STALE_MS ? memory : null;
    if (usable && now() - lastLiveFailureAt < LIVE_COOLDOWN_MS) return usable;

    try {
      return await fetchLive();
    } catch (err) {
      if (!(err instanceof LiveFetchFailed)) throw err;
      const detail = `live fetch failed: ${err.message}`;
      if (usable) {
        log(
          `[oauth] ${provider} jwks: ${detail}; verifying against the persisted set fetched ${hours(now() - usable.fetchedAt)} ago`
        );
        return usable;
      }
      throw unavailable(detail);
    }
  }

  async function current(): Promise<LoadedSet> {
    const fresh = freshOrNull(memory);
    if (fresh) return fresh;
    // One refresh per instance at a time: concurrent sign-ins share it.
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    async keys() {
      const set = await current();
      return async (header, token) => {
        try {
          return await set.local(header, token);
        } catch (err) {
          /**
           * An unknown `kid` is how a key rotation looks from here. Fetch once
           * (with the same retries) and try again. If that fetch fails, the
           * error propagates and the caller refuses the token as 401 — a
           * token-dependent outcome, so it stays indistinguishable from any
           * other bad token. That is the fail-closed half of the fallback.
           */
          if (!(err instanceof errors.JWKSNoMatchingKey)) throw err;
          if (now() - lastLiveAttemptAt < LIVE_COOLDOWN_MS) throw err;
          const fresh = await fetchLive();
          return fresh.local(header, token);
        }
      };
    },
  };
}
