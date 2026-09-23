/**
 * The native OAuth exchange is the one place where a stranger's bytes decide
 * who you are signed in as, so these tests are about REFUSAL more than about
 * the happy path.
 *
 * Two layers on purpose:
 *
 *  - Most tests INJECT the verifier, because what we have to get right is
 *    which options we hand jose (audience above all) and what we do with the
 *    claims that come back.
 *  - The "real jose" block at the bottom injects a verifier that runs the
 *    ACTUAL jwtVerify against a locally generated key set. Without it every
 *    test here would still pass if `defaultVerify` were replaced by a bare
 *    `decodeJwt` — i.e. the suite would be green with no signature checking
 *    at all. That block is what makes the options load-bearing.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, jwtVerify } from 'jose';

vi.mock('server-only', () => ({}));

import { exchangeRequestSchema, verifyIdentityToken, type VerifyDeps } from './oauthIdentity';
import { HttpError } from './errors';
import {
  createKeySource,
  MAX_STALE_MS,
  MEMORY_FRESH_MS,
  RETRY_DELAYS_MS,
  type JwksStore,
  type StoredJwks,
} from './jwksSource';

const IOS_CLIENT = '111-ios.apps.googleusercontent.com';
const WEB_CLIENT = '222-web.apps.googleusercontent.com';
const APPLE_AUDIENCE = 'com.feraltravels.ios';
const APPLE_SUB = '001234.abcdef0123456789.1234';

/** Far-future, fixed, so `expiresAt` assertions do not depend on the clock. */
const EXP = 1893456000; // 2030-01-01T00:00:00Z
const EXPECTED_EXPIRY = new Date(EXP * 1000);

/** Records the options we passed jose, and returns the claims we dictate. */
function verifierReturning(payload: Record<string, unknown>) {
  const calls: Array<{ issuer: string | string[]; audience: string; clockTolerance: number }> = [];
  const verify: VerifyDeps['verify'] = async (_token, _jwks, options) => {
    calls.push(options);
    // Every real provider token carries `exp` and `sub`; default them here so
    // each test only has to state the claim it is actually about.
    return { payload: { exp: EXP, sub: APPLE_SUB, ...payload } };
  };
  return { verify, calls };
}

/**
 * A key source that is always available and never consulted: these tests
 * inject `verify`, which ignores the keys it is handed. Without it the module
 * would reach for the real network and database. The key source itself is
 * under test in the "provider keys" block at the bottom.
 */
const keySource: VerifyDeps['keySource'] = () => ({
  keys: async () => async () => {
    throw new Error('the injected verifier should not have asked for a key');
  },
});

/** Stands in for jose rejecting a bad signature / expiry / audience. */
const rejectingVerifier: VerifyDeps['verify'] = async () => {
  throw new Error('JWSSignatureVerificationFailed');
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.AUTH_GOOGLE_IOS_CLIENT_ID = IOS_CLIENT;
  process.env.AUTH_GOOGLE_ID = WEB_CLIENT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('Google identity tokens', () => {
  it('accepts a verified address and lowercases it', async () => {
    const { verify } = verifierReturning({
      email: 'Sam@Example.com',
      email_verified: true,
      name: 'Sam Shirley',
    });
    await expect(verifyIdentityToken('google', 'tok', null, { verify, keySource })).resolves.toEqual({
      email: 'sam@example.com',
      name: 'Sam Shirley',
      picture: undefined,
      expiresAt: EXPECTED_EXPIRY,
    });
  });

  it('verifies against the iOS client id, NEVER the web one', async () => {
    // The confused-deputy bug: if this route accepted tokens minted for the
    // web client (or any other client), any app holding a Google token for
    // this user could present it here and be handed their session.
    const { verify, calls } = verifierReturning({ email: 'a@b.com', email_verified: true });
    await verifyIdentityToken('google', 'tok', null, { verify, keySource });

    expect(calls).toHaveLength(1);
    expect(calls[0].audience).toBe(IOS_CLIENT);
    expect(calls[0].audience).not.toBe(WEB_CLIENT);
    expect(calls[0].issuer).toEqual(['https://accounts.google.com', 'accounts.google.com']);
    // Enough slack for device clock drift, not enough to matter for replay.
    expect(calls[0].clockTolerance).toBe(5);
  });

  it('refuses an unverified Google address', async () => {
    // Someone can register a Google account claiming an address they do not
    // own; only the verified flag separates them from the real owner.
    const { verify } = verifierReturning({ email: 'victim@example.com', email_verified: false });
    await expect(verifyIdentityToken('google', 'tok', null, { verify, keySource })).rejects.toMatchObject({
      status: 401,
      message: 'EmailNotVerified',
    });
  });

  it('refuses a token with no email_verified claim at all', async () => {
    const { verify } = verifierReturning({ email: 'victim@example.com' });
    await expect(verifyIdentityToken('google', 'tok', null, { verify, keySource })).rejects.toMatchObject({
      message: 'EmailNotVerified',
    });
  });

  it('accepts the string "true" (providers are inconsistent about the type)', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: 'true' });
    await expect(verifyIdentityToken('google', 'tok', null, { verify, keySource })).resolves.toMatchObject({
      email: 'a@b.com',
    });
  });

  it('turns any verification failure into a flat 401, leaking nothing', async () => {
    await expect(
      verifyIdentityToken('google', 'tok', null, { verify: rejectingVerifier, keySource })
    ).rejects.toMatchObject({ status: 401, message: 'InvalidToken' });
  });

  it('refuses a token that carries no email claim', async () => {
    const { verify } = verifierReturning({ email_verified: true, name: 'No Email' });
    await expect(verifyIdentityToken('google', 'tok', null, { verify, keySource })).rejects.toMatchObject({
      status: 401,
      message: 'InvalidToken',
    });
  });

  it('reports 503 ProviderNotConfigured when the iOS client id is unset', async () => {
    // The pre-launch state: the app hides its Google button, but a stale build
    // could still reach here. Nothing is broken — it just is not set up.
    delete process.env.AUTH_GOOGLE_IOS_CLIENT_ID;
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: true });
    const err = await verifyIdentityToken('google', 'tok', null, { verify, keySource }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 503, message: 'ProviderNotConfigured' });
  });
});

describe('Apple identity tokens', () => {
  it('verifies against the app bundle id and Apple issuer', async () => {
    const { verify, calls } = verifierReturning({ email: 'sam@privaterelay.appleid.com' });
    await verifyIdentityToken('apple', 'tok', null, { verify, keySource });
    expect(calls[0].audience).toBe(APPLE_AUDIENCE);
    expect(calls[0].issuer).toBe('https://appleid.apple.com');
  });

  it('accepts a private-relay address with no email_verified claim', async () => {
    // The ONE case where an absent claim is acceptable: Apple owns and routes
    // @privaterelay.appleid.com, so nobody else could be claiming it.
    const { verify } = verifierReturning({ email: 'abc123@privaterelay.appleid.com' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify, keySource })).resolves.toEqual({
      email: 'abc123@privaterelay.appleid.com',
      name: undefined,
      picture: undefined,
      expiresAt: EXPECTED_EXPIRY,
      subject: APPLE_SUB,
    });
  });

  it('carries the token\'s sub, which the refresh token must match before it is stored', async () => {
    const { verify } = verifierReturning({ email: 'a@privaterelay.appleid.com', sub: 'apple-user-7' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify, keySource })).resolves.toMatchObject({
      subject: 'apple-user-7',
    });
  });

  it('refuses an Apple token with no sub', async () => {
    // Nothing to bind a refresh token to, and not a token Apple would issue.
    const { verify } = verifierReturning({ email: 'a@privaterelay.appleid.com', sub: undefined });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify, keySource })).rejects.toMatchObject({
      status: 401,
      message: 'InvalidToken',
    });
    const empty = verifierReturning({ email: 'a@privaterelay.appleid.com', sub: '' });
    await expect(
      verifyIdentityToken('apple', 'tok', null, { verify: empty.verify, keySource })
    ).rejects.toMatchObject({ message: 'InvalidToken' });
  });

  it('REFUSES a real address with no email_verified claim', async () => {
    // The regression this test exists for: an earlier revision rejected only
    // an explicit `false`, so a token that merely omitted the claim minted a
    // session. createSessionForEmail links by email onto an existing OTP user
    // and stamps users.emailVerified, which the admin guard keys off — so an
    // address Apple never asserted could inherit a real account.
    const { verify } = verifierReturning({ email: 'victim@example.com' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify, keySource })).rejects.toMatchObject({
      status: 401,
      message: 'EmailNotVerified',
    });
  });

  it('accepts a real address when Apple does assert the claim', async () => {
    const { verify } = verifierReturning({ email: 'sam@example.com', email_verified: 'true' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify, keySource })).resolves.toMatchObject({
      email: 'sam@example.com',
    });
  });

  it('still refuses an explicit email_verified: false', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: 'false' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify, keySource })).rejects.toMatchObject({
      message: 'EmailNotVerified',
    });
  });

  it('does not treat a lookalike relay domain as Apple-owned', async () => {
    const { verify } = verifierReturning({ email: 'a@privaterelay.appleid.com.evil.test' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify, keySource })).rejects.toMatchObject({
      message: 'EmailNotVerified',
    });
  });

  it('takes the name from the client, not the token, and only once', async () => {
    // Apple never puts a name in the token; the client can only send one on
    // the user's first-ever authorization.
    const { verify } = verifierReturning({
      email: 'a@b.com',
      email_verified: true,
      name: 'Token Name',
    });
    await expect(
      verifyIdentityToken('apple', 'tok', '  Sam Shirley  ', { verify, keySource })
    ).resolves.toMatchObject({ email: 'a@b.com', name: 'Sam Shirley' });
  });

  it('treats a whitespace-only name as no name', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: true });
    await expect(
      verifyIdentityToken('apple', 'tok', '   ', { verify, keySource })
    ).resolves.toMatchObject({ email: 'a@b.com', name: undefined });
  });

  it('does not fall back to the Google client id for its audience', async () => {
    // A copy-paste of the Google branch would silently accept Apple tokens
    // aimed at a Google client — and vice versa.
    const { verify, calls } = verifierReturning({ email: 'a@b.com', email_verified: true });
    await verifyIdentityToken('apple', 'tok', null, { verify, keySource });
    expect(calls[0].audience).not.toBe(IOS_CLIENT);
  });
});

describe('token expiry', () => {
  it('surfaces the token exp so the replay guard can bound its record', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: true });
    const identity = await verifyIdentityToken('google', 'tok', null, { verify, keySource });
    expect(identity.expiresAt).toEqual(EXPECTED_EXPIRY);
  });

  it('refuses a token with no exp — a bearer credential that never dies', async () => {
    const verify: VerifyDeps['verify'] = async () => ({
      payload: { email: 'a@b.com', email_verified: true },
    });
    await expect(verifyIdentityToken('google', 'tok', null, { verify, keySource })).rejects.toMatchObject({
      status: 401,
      message: 'InvalidToken',
    });
  });
});

/**
 * These run the real jwtVerify against a locally generated key set, so the
 * options the module passes are actually enforced rather than merely recorded.
 */
describe('real jose verification (not a stub)', () => {
  async function setup() {
    // jose 6 generates a NON-extractable private key by default; exportJWK on
    // the public half is fine either way, but be explicit so a future jose
    // change cannot turn this into a confusing runtime failure.
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const localJwks = createLocalJWKSet({ keys: [jwk] });
    // Ignore the module's remote JWKS, keep its options verbatim: what is
    // under test is whether those options reject a bad token.
    const verify: VerifyDeps['verify'] = (token, _jwks, options) =>
      jwtVerify(token, localJwks, options);

    const sign = (
      claims: Record<string, unknown>,
      audience: string,
      issuer: string,
      lifetime?: { iat: number; exp: number }
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(lifetime?.iat)
        .setExpirationTime(lifetime?.exp ?? '1h')
        .sign(privateKey);

    return { verify, sign, privateKey };
  }

  it('accepts a properly signed Google token', async () => {
    const { verify, sign } = await setup();
    const token = await sign(
      { email: 'sam@example.com', email_verified: true },
      IOS_CLIENT,
      'https://accounts.google.com'
    );
    await expect(verifyIdentityToken('google', token, null, { verify, keySource })).resolves.toMatchObject({
      email: 'sam@example.com',
    });
  });

  it('rejects a token minted for the WEB client id', async () => {
    // The audience option is the whole confused-deputy defence. If it were
    // dropped, this token — perfectly signed, perfectly valid — would pass.
    const { verify, sign } = await setup();
    const token = await sign(
      { email: 'sam@example.com', email_verified: true },
      WEB_CLIENT,
      'https://accounts.google.com'
    );
    await expect(verifyIdentityToken('google', token, null, { verify, keySource })).rejects.toMatchObject({
      status: 401,
      message: 'InvalidToken',
    });
  });

  it('rejects a token from the wrong issuer', async () => {
    const { verify, sign } = await setup();
    const token = await sign(
      { email: 'sam@example.com', email_verified: true },
      IOS_CLIENT,
      'https://evil.test'
    );
    await expect(verifyIdentityToken('google', token, null, { verify, keySource })).rejects.toMatchObject({
      message: 'InvalidToken',
    });
  });

  it('rejects a token signed by a different key', async () => {
    const { verify } = await setup();
    const { privateKey: otherKey } = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT({ email: 'victim@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://accounts.google.com')
      .setAudience(IOS_CLIENT)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(otherKey);
    await expect(verifyIdentityToken('google', forged, null, { verify, keySource })).rejects.toMatchObject({
      message: 'InvalidToken',
    });
  });

  it('rejects an expired token', async () => {
    // clockTolerance is 5s; an hour past expiry is not a clock-drift question.
    const { verify, sign } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const stale = await sign(
      { email: 'sam@example.com', email_verified: true },
      IOS_CLIENT,
      'https://accounts.google.com',
      { iat: now - 7200, exp: now - 3600 }
    );
    await expect(verifyIdentityToken('google', stale, null, { verify, keySource })).rejects.toMatchObject({
      message: 'InvalidToken',
    });
  });
});

describe('Google profile photo', () => {
  it('carries a Google-hosted picture through', async () => {
    const picture = 'https://lh3.googleusercontent.com/a/ACg8ocL-abc=s96-c';
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: true, picture });
    await expect(
      verifyIdentityToken('google', 'tok', null, { verify, keySource })
    ).resolves.toMatchObject({ picture });
  });

  it('DROPS a picture claim pointing anywhere but Google', async () => {
    // A verified token proves who the user is, not that every string on it is
    // safe to store and hand to every viewer's browser. sanitizeAvatarUrl is
    // what stops a hostile or merely wrong `picture` becoming a stored URL.
    const { verify } = verifierReturning({
      email: 'a@b.com',
      email_verified: true,
      picture: 'https://evil.example.com/pixel.gif',
    });
    await expect(
      verifyIdentityToken('google', 'tok', null, { verify, keySource })
    ).resolves.toMatchObject({ picture: undefined });
  });

  it('is undefined when the token carries no picture at all', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: true });
    await expect(
      verifyIdentityToken('google', 'tok', null, { verify, keySource })
    ).resolves.toMatchObject({ picture: undefined });
  });

  it('never reads a picture off an APPLE token', async () => {
    // Apple's ID token has no picture claim; if one ever appeared it would not
    // be an Apple-issued photo, so it is ignored rather than trusted.
    const { verify } = verifierReturning({
      email: 'a@b.com',
      email_verified: true,
      picture: 'https://lh3.googleusercontent.com/a/photo',
    });
    const identity = await verifyIdentityToken('apple', 'tok', null, { verify, keySource });
    expect(identity).not.toHaveProperty('picture', expect.any(String));
  });
});

/**
 * The key source, end to end: real jwtVerify, a real signed token, and only
 * the network and the database swapped out — the provider's key endpoint is
 * an injected `fetch`, the persisted set an in-memory store.
 *
 * What these pin down is the 2026-09-21 incident: Apple's /auth/keys was
 * answering 404 to about one request in five, the old code made one fetch and
 * gave up, and the resulting jose error was reported to the user as
 * 401 InvalidToken — the same answer a forged token gets.
 */
describe('provider keys (retry, persisted fallback, 503 when there are none)', () => {
  const APPLE_ISSUER = 'https://appleid.apple.com';
  const T0 = Date.parse('2026-09-21T16:00:00Z');

  async function keyPair(kid: string) {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
    const sign = (claims: Record<string, unknown> = { email: 'abc@privaterelay.appleid.com' }) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(APPLE_ISSUER)
        .setAudience(APPLE_AUDIENCE)
        .setSubject(APPLE_SUB)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);
    return { jwk, sign, privateKey };
  }

  /** An injected fetch that plays back `script` — a status per call, then repeats the last. */
  function scriptedFetch(script: Array<number | 'timeout' | { keys: unknown[] }>) {
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      if (step === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
      if (typeof step === 'number') return new Response(null, { status: step });
      return new Response(JSON.stringify(step), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  function memoryStore(initial?: StoredJwks) {
    let row = initial ?? null;
    const saves: StoredJwks[] = [];
    const store: JwksStore = {
      load: async () => row,
      save: async (_provider, value) => {
        saves.push(value);
        row = value;
      },
    };
    return { store, saves, current: () => row };
  }

  function harness(fetchImpl: typeof fetch, store: JwksStore, now = () => T0) {
    const logs: string[] = [];
    const source = createKeySource('apple', 'https://appleid.apple.com/auth/keys', {
      fetch: fetchImpl,
      store,
      now,
      sleep: async () => {},
      log: (line) => logs.push(line),
    });
    const deps: VerifyDeps = { keySource: () => source };
    return { deps, logs };
  }

  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('retries a 404 and verifies once the provider answers 200', async () => {
    // The exact production failure: jose threw ERR_JOSE_GENERIC on the first
    // (and only) 404. One retry is all it takes most of the time.
    const { jwk, sign } = await keyPair('k1');
    const { impl, calls } = scriptedFetch([404, { keys: [jwk] }]);
    const { deps, logs } = harness(impl, memoryStore().store);

    await expect(verifyIdentityToken('apple', await sign(), null, deps)).resolves.toMatchObject({
      email: 'abc@privaterelay.appleid.com',
    });
    expect(calls).toHaveLength(2);
    expect(logs.join('\n')).toContain('fetched on attempt 2 after http 404');
  });

  it('survives a run of failures of every kind within the retry budget', async () => {
    // A literal script, not one derived from RETRY_DELAYS_MS: shrinking the
    // retry schedule must fail this test, not quietly shrink it too.
    const { jwk, sign } = await keyPair('k1');
    const { impl, calls } = scriptedFetch([404, 'timeout', 500, 404, { keys: [jwk] }]);
    const { deps } = harness(impl, memoryStore().store);

    await expect(verifyIdentityToken('apple', await sign(), null, deps)).resolves.toBeTruthy();
    expect(calls).toHaveLength(5);
  });

  it('live fetch dead + a fresh persisted set: a properly signed token verifies', async () => {
    const { jwk, sign } = await keyPair('k1');
    const { impl } = scriptedFetch([404]);
    // An hour old: too old to skip the live fetch, well inside the bound.
    const { store } = memoryStore({ jwks: { keys: [jwk] }, fetchedAt: new Date(T0 - 3_600_000) });
    const { deps, logs } = harness(impl, store);

    await expect(verifyIdentityToken('apple', await sign(), null, deps)).resolves.toMatchObject({
      email: 'abc@privaterelay.appleid.com',
    });
    expect(logs.join('\n')).toMatch(/live fetch failed: http 404.*persisted set fetched 1\.0h ago/);
  });

  it('live fetch dead + a persisted set past the staleness bound: 503 ProviderUnavailable', async () => {
    const { jwk, sign } = await keyPair('k1');
    const { impl } = scriptedFetch([404]);
    const { store } = memoryStore({
      jwks: { keys: [jwk] },
      fetchedAt: new Date(T0 - MAX_STALE_MS - 60_000),
    });
    const { deps } = harness(impl, store);

    const err = await verifyIdentityToken('apple', await sign(), null, deps).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 503, message: 'ProviderUnavailable' });
    // The upstream status is in the log, next to the code.
    expect(errorSpy.mock.calls.flat().join('\n')).toMatch(
      /apple id-token verification failed: ProviderUnavailable \(live fetch failed: http 404(, http 404)+; persisted set 72\.0h old, past the 72\.0h bound\)/
    );
  });

  it('live fetch dead + nothing persisted: 503 ProviderUnavailable, not 401', async () => {
    const { sign } = await keyPair('k1');
    const { impl, calls } = scriptedFetch([404]);
    const { deps } = harness(impl, memoryStore().store);

    const err = await verifyIdentityToken('apple', await sign(), null, deps).catch((e) => e);
    expect(err).toMatchObject({ status: 503, message: 'ProviderUnavailable' });
    expect(calls).toHaveLength(RETRY_DELAYS_MS.length + 1);
  });

  it('the 503 is decided before the token is read: garbage gets it too, so it is no oracle', async () => {
    const { impl } = scriptedFetch([404]);
    const { deps } = harness(impl, memoryStore().store);
    await expect(verifyIdentityToken('apple', 'not-a-jwt', null, deps)).rejects.toMatchObject({
      status: 503,
      message: 'ProviderUnavailable',
    });
  });

  it('a forged token with the keys available is still a flat 401 InvalidToken', async () => {
    const { jwk } = await keyPair('k1');
    // Same kid, different private key: the forgery a stranger can actually make.
    const { sign: forge } = await keyPair('k1');
    const { impl } = scriptedFetch([{ keys: [jwk] }]);
    const { deps } = harness(impl, memoryStore().store);

    const err = await verifyIdentityToken('apple', await forge(), null, deps).catch((e) => e);
    expect(err).toMatchObject({ status: 401, message: 'InvalidToken' });
  });

  it('a forged token is 401 even when it is only the persisted fallback that is available', async () => {
    const { jwk } = await keyPair('k1');
    const { sign: forge } = await keyPair('k1');
    const { impl } = scriptedFetch([404]);
    const { store } = memoryStore({ jwks: { keys: [jwk] }, fetchedAt: new Date(T0 - 3_600_000) });
    const { deps } = harness(impl, store);

    await expect(verifyIdentityToken('apple', await forge(), null, deps)).rejects.toMatchObject({
      status: 401,
      message: 'InvalidToken',
    });
  });

  it('a successful live fetch refreshes the persisted set', async () => {
    const { jwk: oldJwk } = await keyPair('old');
    const { jwk, sign } = await keyPair('k1');
    const { impl } = scriptedFetch([{ keys: [jwk] }]);
    const mem = memoryStore({ jwks: { keys: [oldJwk] }, fetchedAt: new Date(T0 - 3_600_000) });
    const { deps } = harness(impl, mem.store);

    await verifyIdentityToken('apple', await sign(), null, deps);
    expect(mem.saves).toHaveLength(1);
    expect(mem.current()).toEqual({ jwks: { keys: [jwk] }, fetchedAt: new Date(T0) });
  });

  it('a set persisted minutes ago by another instance is used without asking the provider', async () => {
    const { jwk, sign } = await keyPair('k1');
    const { impl, calls } = scriptedFetch([404]);
    const { store } = memoryStore({
      jwks: { keys: [jwk] },
      fetchedAt: new Date(T0 - MEMORY_FRESH_MS / 2),
    });
    const { deps } = harness(impl, store);

    await expect(verifyIdentityToken('apple', await sign(), null, deps)).resolves.toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('a warm instance does not refetch within the freshness window', async () => {
    const { jwk, sign } = await keyPair('k1');
    const { impl, calls } = scriptedFetch([{ keys: [jwk] }]);
    const { deps } = harness(impl, memoryStore().store);

    await verifyIdentityToken('apple', await sign(), null, deps);
    await verifyIdentityToken('apple', await sign(), null, deps);
    expect(calls).toHaveLength(1);
  });

  it('a rotated-in key is fetched when the token names a kid the set lacks', async () => {
    const { jwk: oldJwk } = await keyPair('old');
    const { jwk: newJwk, sign } = await keyPair('new');
    const { impl, calls } = scriptedFetch([{ keys: [newJwk] }]);
    // Fresh from another instance, so the first lookup uses it without a fetch.
    const { store } = memoryStore({ jwks: { keys: [oldJwk] }, fetchedAt: new Date(T0 - 60_000) });
    const { deps } = harness(impl, store);

    await expect(verifyIdentityToken('apple', await sign(), null, deps)).resolves.toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it('a stale fallback fails CLOSED on a rotated key: 401, never a skipped signature', async () => {
    // Live is down, the fallback predates the rotation: the token cannot be
    // checked, so it is refused. That answer depends on the token (its kid),
    // so it is the flat 401, not the 503.
    const { jwk: oldJwk } = await keyPair('old');
    const { sign } = await keyPair('new');
    const { impl } = scriptedFetch([404]);
    const { store } = memoryStore({ jwks: { keys: [oldJwk] }, fetchedAt: new Date(T0 - 60_000) });
    const { deps } = harness(impl, store);

    await expect(verifyIdentityToken('apple', await sign(), null, deps)).rejects.toMatchObject({
      status: 401,
      message: 'InvalidToken',
    });
  });

  it('a database that cannot be read or written does not break a live-verified sign-in', async () => {
    const { jwk, sign } = await keyPair('k1');
    const { impl } = scriptedFetch([{ keys: [jwk] }]);
    const broken: JwksStore = {
      load: async () => {
        throw new Error('connection refused');
      },
      save: async () => {
        throw new Error('connection refused');
      },
    };
    const { deps, logs } = harness(impl, broken);

    await expect(verifyIdentityToken('apple', await sign(), null, deps)).resolves.toBeTruthy();
    expect(logs.join('\n')).toContain('could not persist');
  });

  it('a 200 whose body is not a key set counts as a failed attempt, and is never persisted', async () => {
    const { jwk, sign } = await keyPair('k1');
    const { impl, calls } = scriptedFetch([{ keys: [] }, { keys: [jwk] }]);
    const mem = memoryStore();
    const { deps } = harness(impl, mem.store);

    await expect(verifyIdentityToken('apple', await sign(), null, deps)).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(mem.saves).toEqual([{ jwks: { keys: [jwk] }, fetchedAt: new Date(T0) }]);
  });

  it('Google goes through the same key source', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' };
    const { impl, calls } = scriptedFetch([404, { keys: [jwk] }]);
    const source = createKeySource('google', 'https://www.googleapis.com/oauth2/v3/certs', {
      fetch: impl,
      store: memoryStore().store,
      now: () => T0,
      sleep: async () => {},
      log: () => {},
    });
    const token = await new SignJWT({ email: 'sam@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(IOS_CLIENT)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    await expect(
      verifyIdentityToken('google', token, null, { keySource: () => source })
    ).resolves.toMatchObject({ email: 'sam@example.com' });
    expect(calls).toHaveLength(2);
  });
});

/**
 * The exchange route's payload. One optional field was added for account
 * deletion's Apple revoke (App Review 5.1.1(v)); nothing else loosened.
 */
describe('exchange request schema', () => {
  const ok = (body: unknown) => exchangeRequestSchema.safeParse(body).success;

  it('accepts what build 11 sends, for both providers', () => {
    expect(ok({ provider: 'google', idToken: 'x' })).toBe(true);
    expect(ok({ provider: 'apple', idToken: 'x', fullName: 'Sam' })).toBe(true);
    expect(ok({ provider: 'apple', idToken: 'x', fullName: null })).toBe(true);
  });

  it('accepts an Apple authorization code', () => {
    expect(ok({ provider: 'apple', idToken: 'x', fullName: null, authorizationCode: 'c.abc' })).toBe(true);
  });

  it('refuses an authorization code on a Google request', () => {
    expect(ok({ provider: 'google', idToken: 'x', authorizationCode: 'c.abc' })).toBe(false);
  });

  it('refuses an empty or oversized code, and a null one', () => {
    expect(ok({ provider: 'apple', idToken: 'x', authorizationCode: '' })).toBe(false);
    expect(ok({ provider: 'apple', idToken: 'x', authorizationCode: 'c'.repeat(4097) })).toBe(false);
    expect(ok({ provider: 'apple', idToken: 'x', authorizationCode: null })).toBe(false);
  });

  it('refuses an unknown key rather than dropping it', () => {
    expect(ok({ provider: 'apple', idToken: 'x', refreshToken: 'r.abc' })).toBe(false);
  });
});
