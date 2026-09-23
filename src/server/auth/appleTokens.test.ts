/**
 * Sign in with Apple's REST side — the authorization-code exchange at sign-in
 * and the revoke at account deletion (App Review 5.1.1(v)).
 *
 * Apple is never contacted: every request goes to an injected `fetch` that
 * plays back a script, and the client secret is signed with a P-256 key
 * generated here, then verified with its public half — so the claims Apple
 * would check are checked for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  type CryptoKey as JoseCryptoKey,
} from 'jose';

vi.mock('server-only', () => ({}));

import {
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  CLIENT_SECRET_TTL_S,
  DEFAULT_APPLE_TEAM_ID,
  captureAppleRefreshToken,
  exchangeAuthorizationCode,
  mintClientSecret,
  normalizePrivateKey,
  revokeRefreshToken,
  type AppleExchangeResult,
  type AppleTokenDeps,
} from './appleTokens';

const BUNDLE_ID = 'com.feraltravels.ios';
const KEY_ID = 'ABC123DEFG';
const T0 = Date.parse('2026-09-23T12:00:00Z');

const CODE = 'c1a2b3.0.secret-authorization-code';
const REFRESH = 'r9f8e7.0.SECRET-refresh-TOKEN';
const SUB = '001234.abcdef0123456789.1234';

let publicKey: JoseCryptoKey;
let pem: string;

beforeEach(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  publicKey = pair.publicKey;
  pem = await exportPKCS8(pair.privateKey);
});

/** An unsigned-looking id_token is fine: the code decodes, it does not verify. */
async function idTokenFor(sub: string | undefined): Promise<string> {
  const { privateKey } = await generateKeyPair('ES256');
  const jwt = new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setIssuer('https://appleid.apple.com');
  if (sub !== undefined) jwt.setSubject(sub);
  return jwt.sign(privateKey);
}

type Step =
  | number
  | 'timeout'
  | 'network'
  | { status: number; json: Record<string, unknown> };

interface Call {
  url: string;
  form: URLSearchParams;
  cache: RequestCache | undefined;
}

/** Plays back `script` — one step per call, then repeats the last. */
function scriptedFetch(script: Step[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      form: new URLSearchParams(String(init?.body ?? '')),
      cache: init?.cache,
    });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    if (step === 'network') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    // The 2026-09-21 failure shape: a 404 with an EMPTY body.
    if (typeof step === 'number') return new Response(null, { status: step });
    return Response.json(step.json, { status: step.status });
  }) as typeof fetch;
  return { impl, calls };
}

function deps(script: Step[], env: Record<string, string | undefined> = {}) {
  const { impl, calls } = scriptedFetch(script);
  const logs: string[] = [];
  const d: AppleTokenDeps = {
    fetch: impl,
    now: () => T0,
    sleep: async () => {},
    env: { APPLE_SIGNIN_KEY_ID: KEY_ID, APPLE_SIGNIN_PRIVATE_KEY: pem, ...env },
    log: (line) => logs.push(line),
  };
  return { d, calls, logs };
}

describe('client secret', () => {
  it('is an ES256 JWT Apple would accept: kid, team issuer, bundle-id subject, 5 minutes', async () => {
    const minted = await mintClientSecret(deps([]).d);
    if (!minted.ok) throw new Error(minted.detail);

    expect(decodeProtectedHeader(minted.secret)).toEqual({ alg: 'ES256', kid: KEY_ID });
    const { payload } = await jwtVerify(minted.secret, publicKey, {
      issuer: DEFAULT_APPLE_TEAM_ID,
      audience: 'https://appleid.apple.com',
      subject: BUNDLE_ID,
      currentDate: new Date(T0),
    });
    expect(payload.iat).toBe(T0 / 1000);
    expect(payload.exp).toBe(T0 / 1000 + CLIENT_SECRET_TTL_S);
  });

  it('takes the team id from APPLE_TEAM_ID when set', async () => {
    const minted = await mintClientSecret(deps([], { APPLE_TEAM_ID: 'ZZZ9999999' }).d);
    if (!minted.ok) throw new Error(minted.detail);
    await expect(
      jwtVerify(minted.secret, publicKey, { issuer: 'ZZZ9999999', currentDate: new Date(T0) })
    ).resolves.toBeTruthy();
  });

  it('accepts a key pasted with literal \\n escapes, and one without PEM armour', async () => {
    const escaped = pem.replace(/\n/g, '\\n');
    expect(escaped).not.toContain('\n');
    const a = await mintClientSecret(deps([], { APPLE_SIGNIN_PRIVATE_KEY: escaped }).d);
    expect(a.ok).toBe(true);

    const bare = pem
      .split('\n')
      .filter((l) => l && !l.startsWith('-----'))
      .join('');
    const b = await mintClientSecret(deps([], { APPLE_SIGNIN_PRIVATE_KEY: bare }).d);
    expect(b.ok).toBe(true);
    expect(normalizePrivateKey(escaped)).toBe(pem.trim());
  });

  it('is a typed not_configured result — never a throw — when the key id or key is missing', async () => {
    await expect(
      mintClientSecret(deps([], { APPLE_SIGNIN_KEY_ID: undefined }).d)
    ).resolves.toMatchObject({ ok: false, reason: 'not_configured', detail: expect.stringContaining('APPLE_SIGNIN_KEY_ID') });
    await expect(
      mintClientSecret(deps([], { APPLE_SIGNIN_PRIVATE_KEY: '' }).d)
    ).resolves.toMatchObject({ ok: false, reason: 'not_configured' });
    const garbage = await mintClientSecret(deps([], { APPLE_SIGNIN_PRIVATE_KEY: 'not a key' }).d);
    expect(garbage).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(JSON.stringify(garbage)).not.toContain('not a key');
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts the code as a form and returns the refresh token and the id_token sub', async () => {
    const { d, calls } = deps([
      { status: 200, json: { refresh_token: REFRESH, id_token: await idTokenFor(SUB), token_type: 'Bearer' } },
    ]);
    await expect(exchangeAuthorizationCode(CODE, d)).resolves.toEqual({
      ok: true,
      refreshToken: REFRESH,
      sub: SUB,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(APPLE_TOKEN_URL);
    expect(calls[0].cache).toBe('no-store');
    expect(calls[0].form.get('client_id')).toBe(BUNDLE_ID);
    expect(calls[0].form.get('code')).toBe(CODE);
    expect(calls[0].form.get('grant_type')).toBe('authorization_code');
    await expect(
      jwtVerify(calls[0].form.get('client_secret') as string, publicKey, { currentDate: new Date(T0) })
    ).resolves.toBeTruthy();
  });

  it('reports Apple 400 invalid_grant as final, without retrying a spent code', async () => {
    const { d, calls } = deps([{ status: 400, json: { error: 'invalid_grant' } }]);
    await expect(exchangeAuthorizationCode(CODE, d)).resolves.toEqual({
      ok: false,
      reason: 'apple_error',
      detail: 'http 400 invalid_grant',
    });
    expect(calls).toHaveLength(1);
  });

  it('never calls Apple when the key is not configured', async () => {
    const { d, calls } = deps([200], { APPLE_SIGNIN_PRIVATE_KEY: undefined });
    await expect(exchangeAuthorizationCode(CODE, d)).resolves.toMatchObject({
      ok: false,
      reason: 'not_configured',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a 200 with no refresh token or no sub', async () => {
    const noRefresh = deps([{ status: 200, json: { id_token: await idTokenFor(SUB) } }]);
    await expect(exchangeAuthorizationCode(CODE, noRefresh.d)).resolves.toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    const noSub = deps([{ status: 200, json: { refresh_token: REFRESH, id_token: await idTokenFor(undefined) } }]);
    await expect(exchangeAuthorizationCode(CODE, noSub.d)).resolves.toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rides out Apple front-end 404s like the revoke does', async () => {
    const { d, calls } = deps([
      404,
      { status: 200, json: { refresh_token: REFRESH, id_token: await idTokenFor(SUB) } },
    ]);
    await expect(exchangeAuthorizationCode(CODE, d)).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });
});

describe('revokeRefreshToken', () => {
  it('posts the token with the refresh_token hint; 200 is success', async () => {
    const { d, calls } = deps([200]);
    await expect(revokeRefreshToken(REFRESH, d)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(APPLE_REVOKE_URL);
    expect(calls[0].cache).toBe('no-store');
    expect(calls[0].form.get('client_id')).toBe(BUNDLE_ID);
    expect(calls[0].form.get('token')).toBe(REFRESH);
    expect(calls[0].form.get('token_type_hint')).toBe('refresh_token');
    expect(calls[0].form.get('client_secret')).toBeTruthy();
  });

  it('retries past a 404 (the 2026-09-21 failure) and succeeds', async () => {
    const { d, calls, logs } = deps([404, 200]);
    await expect(revokeRefreshToken(REFRESH, d)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(logs).toEqual(['[apple] revoke: succeeded on attempt 2 after http 404']);
  });

  it('gives up after three attempts and says what each one got', async () => {
    const { d, calls } = deps([404, 'timeout', 503]);
    await expect(revokeRefreshToken(REFRESH, d)).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
      detail: 'http 404, timeout, http 503',
    });
    expect(calls).toHaveLength(3);
  });

  it('does not retry Apple refusing the client', async () => {
    const { d, calls } = deps([{ status: 400, json: { error: 'invalid_client' } }]);
    await expect(revokeRefreshToken(REFRESH, d)).resolves.toMatchObject({
      ok: false,
      reason: 'apple_error',
      detail: 'http 400 invalid_client',
    });
    expect(calls).toHaveLength(1);
  });

  it('is not_configured without the key, and asks Apple nothing', async () => {
    const { d, calls } = deps([200], { APPLE_SIGNIN_KEY_ID: '' });
    await expect(revokeRefreshToken(REFRESH, d)).resolves.toMatchObject({
      ok: false,
      reason: 'not_configured',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('secrets never reach a log line', () => {
  it('no token, code, secret or key appears in any log or failure detail', async () => {
    const lines: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => void lines.push(a.join(' ')));
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
    try {
      const runs = [
        deps([404, 'network', { status: 400, json: { error: 'invalid_grant', error_description: REFRESH } }]),
        deps([404, 200]),
        deps(['timeout', 'timeout', 'timeout']),
      ];
      for (const run of runs) {
        const ex = await exchangeAuthorizationCode(CODE, run.d);
        const rv = await revokeRefreshToken(REFRESH, run.d);
        lines.push(...run.logs, JSON.stringify(ex.ok ? { ok: true } : ex), JSON.stringify(rv));
      }
      const secret = await mintClientSecret(deps([]).d);
      const secrets = [CODE, REFRESH, pem, secret.ok ? secret.secret : 'x'];
      const all = lines.join('\n');
      expect(all.length).toBeGreaterThan(0);
      for (const s of secrets) expect(all).not.toContain(s);
      expect(all).not.toContain('PRIVATE KEY');
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('captureAppleRefreshToken (sign-in side)', () => {
  const ok: AppleExchangeResult = { ok: true, refreshToken: REFRESH, sub: SUB };
  const input = { userId: 'user-1', identitySub: SUB, authorizationCode: CODE };

  function harness(overrides: Partial<Parameters<typeof captureAppleRefreshToken>[1]> = {}) {
    const stored: Array<[string, string, string]> = [];
    const logged: string[] = [];
    const d = {
      exchange: async () => ok,
      encrypt: (p: string) => `enc(${p.length})`,
      store: async (u: string, s: string, e: string) => void stored.push([u, s, e]),
      logFailure: async (_u: string, m: string) => void logged.push(m),
      ...overrides,
    };
    return { d, stored, logged };
  }

  it('stores the ENCRYPTED token against the user and the Apple sub', async () => {
    const { d, stored, logged } = harness();
    await expect(captureAppleRefreshToken(input, d)).resolves.toBe('stored');
    expect(stored).toEqual([['user-1', SUB, `enc(${REFRESH.length})`]]);
    expect(logged).toEqual([]);
  });

  it('refuses a token whose sub is not the identity token\'s', async () => {
    const { d, stored, logged } = harness({ exchange: async () => ({ ...ok, sub: 'someone-else' }) });
    await expect(captureAppleRefreshToken(input, d)).resolves.toBe('failed');
    expect(stored).toEqual([]);
    expect(logged[0]).toMatch(/sub does not match/);
  });

  it('never stores plaintext when there is no key', async () => {
    const { d, stored, logged } = harness({ encrypt: () => null });
    await expect(captureAppleRefreshToken(input, d)).resolves.toBe('failed');
    expect(stored).toEqual([]);
    expect(logged).toEqual(['no encryption key']);
  });

  it('logs an Apple refusal and does not store', async () => {
    const { d, stored, logged } = harness({
      exchange: async () => ({ ok: false, reason: 'apple_error', detail: 'http 400 invalid_grant' }),
    });
    await expect(captureAppleRefreshToken(input, d)).resolves.toBe('failed');
    expect(stored).toEqual([]);
    expect(logged).toEqual(['http 400 invalid_grant']);
  });

  it('never rejects — not when the exchange throws, the store throws, or the log itself throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boom = async () => {
        throw Object.assign(new Error(`insert failed: ${REFRESH}`), { code: '23503' });
      };
      const a = harness({ exchange: boom });
      await expect(captureAppleRefreshToken(input, a.d)).resolves.toBe('failed');
      const b = harness({ store: boom });
      await expect(captureAppleRefreshToken(input, b.d)).resolves.toBe('failed');
      // A driver message can quote values; only the name and code are logged.
      expect(b.logged).toEqual(['could not store the refresh token: Error 23503']);
      const c = harness({ store: boom, logFailure: boom });
      await expect(captureAppleRefreshToken(input, c.d)).resolves.toBe('failed');
      expect(err).toHaveBeenCalled();
      expect(JSON.stringify(err.mock.calls)).not.toContain(REFRESH);
    } finally {
      err.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The exchange route itself: a failed token capture must never fail sign-in.
// Everything the route touches besides the capture is stubbed.
// ---------------------------------------------------------------------------

const routeMocks = vi.hoisted(() => ({
  createSessionForEmail: vi.fn(),
  storeAppleRefreshToken: vi.fn(),
  logUsageEvent: vi.fn(),
  verifyIdentityToken: vi.fn(),
}));

vi.mock('@/server/auth/otp', () => ({ createSessionForEmail: routeMocks.createSessionForEmail }));
vi.mock('@/server/payments', () => ({ assertSignupGateOpen: async () => {} }));
vi.mock('@/server/auth/oauthReplay', () => ({
  consumeIdToken: async () => {},
  pruneExpiredTokenUses: async () => {},
}));
vi.mock('@/server/auth/guards', () => ({
  errorResponse: (e: unknown) => Response.json({ error: String(e) }, { status: 500 }),
}));
vi.mock('@/server/repos/appleTokens', () => ({
  storeAppleRefreshToken: routeMocks.storeAppleRefreshToken,
}));
vi.mock('@/server/repos/usage', () => ({ logUsageEvent: routeMocks.logUsageEvent }));
vi.mock('./oauthIdentity', async (importActual) => ({
  ...(await importActual<typeof import('./oauthIdentity')>()),
  verifyIdentityToken: routeMocks.verifyIdentityToken,
}));

describe('POST /api/mobile/oauth/exchange', () => {
  const ENV = { ...process.env };
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    routeMocks.createSessionForEmail.mockResolvedValue({
      sessionToken: 'session-tok',
      expires: new Date(T0 + 86_400_000),
      userId: 'user-1',
    });
    routeMocks.verifyIdentityToken.mockReset().mockResolvedValue({
      email: 'a@privaterelay.appleid.com',
      expiresAt: new Date(T0 + 600_000),
      subject: SUB,
    });
    routeMocks.storeAppleRefreshToken.mockReset();
    routeMocks.logUsageEvent.mockReset().mockResolvedValue(undefined);
    process.env.APPLE_SIGNIN_KEY_ID = KEY_ID;
    process.env.APPLE_SIGNIN_PRIVATE_KEY = pem;
    process.env.DELETED_USER_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
    const idToken = await idTokenFor(SUB);
    globalThis.fetch = (async () =>
      Response.json({ refresh_token: REFRESH, id_token: idToken })) as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...ENV };
    globalThis.fetch = realFetch;
  });

  async function post(body: unknown) {
    const { POST } = await import('@/app/api/mobile/oauth/exchange/route');
    return POST(new Request('http://x/api/mobile/oauth/exchange', { method: 'POST', body: JSON.stringify(body) }));
  }

  it('stores the encrypted refresh token for an Apple sign-in carrying a code', async () => {
    const res = await post({ provider: 'apple', idToken: 'x', authorizationCode: CODE });
    expect(res.status).toBe(200);
    expect(routeMocks.storeAppleRefreshToken).toHaveBeenCalledTimes(1);
    const [userId, sub, encrypted] = routeMocks.storeAppleRefreshToken.mock.calls[0];
    expect([userId, sub]).toEqual(['user-1', SUB]);
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(REFRESH);
  });

  it('still returns the session when storing the token throws, and logs it', async () => {
    routeMocks.storeAppleRefreshToken.mockRejectedValue(new Error('connection terminated'));
    const res = await post({ provider: 'apple', idToken: 'x', authorizationCode: CODE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: 'session-tok', user: { id: 'user-1' } });
    expect(routeMocks.logUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', provider: 'apple:token-exchange', success: false })
    );
  });

  it('still returns the session when Apple is down AND the log write fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      globalThis.fetch = (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch;
      routeMocks.logUsageEvent.mockRejectedValue(new Error('db down'));
      const res = await post({ provider: 'apple', idToken: 'x', authorizationCode: CODE });
      expect(res.status).toBe(200);
      expect(routeMocks.storeAppleRefreshToken).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  }, 20_000);

  it('does nothing — no exchange, no log — without a code (build 11)', async () => {
    const res = await post({ provider: 'apple', idToken: 'x', fullName: null });
    expect(res.status).toBe(200);
    expect(routeMocks.storeAppleRefreshToken).not.toHaveBeenCalled();
    expect(routeMocks.logUsageEvent).not.toHaveBeenCalled();
  });

  it('400 InvalidRequest for a Google request carrying a code', async () => {
    const res = await post({ provider: 'google', idToken: 'x', authorizationCode: CODE });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'InvalidRequest' });
    expect(routeMocks.verifyIdentityToken).not.toHaveBeenCalled();
  });
});
