import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { SignJWT, generateKeyPair } from 'jose';

/**
 * POST /api/mobile/oauth/exchange is the one route where a stranger's bytes
 * decide who you are signed in as. It takes a provider ID token and hands back
 * a 30-day session, so every test here is about REFUSAL.
 *
 * We cannot mint a token Google or Apple would vouch for, so the happy path
 * belongs to the unit suite (oauthIdentity.test.ts) and to a real device. What
 * this spec covers is the half that runs against the DEPLOYED app: that a
 * forged token is refused by the deployment's own JWKS fetch, that refusals
 * are flat error codes rather than stack traces, and that a refusal never
 * comes with a session token attached.
 *
 * "Refused" means 401 InvalidToken EXACTLY — see `expectForgeryRefused`. On
 * 2026-09-21 this spec passed in a preview whose logs showed the deployment
 * could not fetch Apple's keys at all (ERR_JOSE_GENERIC, three times), because
 * back then "provider unreachable" and "forged token" were both 401
 * InvalidToken. The server now answers the first with 503 ProviderUnavailable,
 * and this spec must fail on it: a verifier with no keys has proved nothing
 * about forgeries.
 *
 * Every token below is signed with a key pair generated in-process. It is a
 * structurally perfect JWT — right algorithm, right issuer, right audience,
 * valid `exp` — and the ONLY thing wrong with it is that the provider never
 * signed it. That is exactly the token an attacker can produce, so it is the
 * one worth firing at a live URL.
 *
 * Apple carries most of the cases because its audience is the bundle id with a
 * safe default, so these assertions hold on any deployment. The single Google
 * test is deliberately a configuration check as well — see its comment.
 */

const EXCHANGE = '/api/mobile/oauth/exchange';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_AUDIENCE = 'com.feraltravels.ios';

/** A JWT nobody but this test process has ever signed. */
async function forgeToken(claims: Record<string, unknown>, expiresIn: string | null = '1h') {
  const { privateKey } = await generateKeyPair('RS256');
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'e2e-forged-key' })
    .setIssuedAt();
  if (expiresIn !== null) jwt = jwt.setExpirationTime(expiresIn);
  return jwt.sign(privateKey);
}

function appleClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: APPLE_ISSUER,
    aud: APPLE_AUDIENCE,
    sub: 'e2e-forged-subject',
    email: 'forged@e2e.feraltravels.com',
    email_verified: true,
    ...overrides,
  };
}

async function exchange(request: APIRequestContext, data: unknown) {
  return request.post(EXCHANGE, {
    data: data as Record<string, unknown>,
    headers: { 'content-type': 'application/json' },
    failOnStatusCode: false,
  });
}

/** The route answers `{ error: '<Code>' }` and nothing else. */
async function errorCode(res: { json: () => Promise<unknown> }): Promise<string> {
  const body = (await res.json()) as Record<string, unknown>;
  return typeof body.error === 'string' ? body.error : JSON.stringify(body);
}

/**
 * The deployment looked at the token and refused it: 401 InvalidToken, and
 * nothing else passes. Not any 401 (EmailNotVerified would mean the signature
 * check let a forgery through to the claims), and above all not 503
 * ProviderUnavailable, which means the deployment never got the provider's
 * keys and so never checked the token at all.
 */
async function expectForgeryRefused(res: APIResponse) {
  const status = res.status();
  const code = await errorCode(res);
  expect(
    { status, code },
    code === 'ProviderUnavailable'
      ? "503 ProviderUnavailable: this deployment could not obtain the provider's signing " +
          'keys, so the forged token was never checked. Look for "ProviderUnavailable" in ' +
          "the deployment's logs for the upstream status."
      : 'a forged token must be refused as 401 InvalidToken and nothing else'
  ).toEqual({ status: 401, code: 'InvalidToken' });
}

test.describe('native OAuth exchange', () => {
  test.describe('malformed requests are rejected before any verification', () => {
    const cases: Array<[string, unknown]> = [
      ['an empty body', {}],
      ['no provider', { idToken: 'x' }],
      ['no idToken', { provider: 'google' }],
      ['an empty idToken', { provider: 'google', idToken: '' }],
      ['a provider we do not support', { provider: 'facebook', idToken: 'x' }],
      ['a fullName over the limit', { provider: 'apple', idToken: 'x', fullName: 'n'.repeat(201) }],
    ];

    for (const [label, body] of cases) {
      test(`400 InvalidRequest for ${label}`, async ({ request }) => {
        const res = await exchange(request, body);

        expect(res.status()).toBe(400);
        expect(await errorCode(res)).toBe('InvalidRequest');
      });
    }

    test('400 InvalidRequest for a body that is not JSON at all', async ({ request }) => {
      // The route swallows the parse error into `{}` on purpose, so this must
      // be a 400 rather than the 500 an unmapped ZodError would produce.
      const res = await request.post(EXCHANGE, {
        data: 'not json',
        headers: { 'content-type': 'application/json' },
        failOnStatusCode: false,
      });

      expect(res.status()).toBe(400);
      expect(await errorCode(res)).toBe('InvalidRequest');
    });
  });

  test.describe('forged tokens are refused', () => {
    test('a string that is not a JWT', async ({ request }) => {
      const res = await exchange(request, { provider: 'apple', idToken: 'not-a-jwt' });

      await expectForgeryRefused(res);
    });

    test('a well-formed token signed with a key Apple does not publish', async ({ request }) => {
      // The core case. Correct issuer, correct audience, unexpired, verified
      // email — and signed by us. If this ever returns 200, the deployment is
      // handing out sessions to anyone who can format a JWT.
      const idToken = await forgeToken(appleClaims());
      const res = await exchange(request, { provider: 'apple', idToken });

      await expectForgeryRefused(res);
    });

    test('an expired token', async ({ request }) => {
      const idToken = await forgeToken(appleClaims(), '-10m');
      const res = await exchange(request, { provider: 'apple', idToken });

      await expectForgeryRefused(res);
    });

    test('a token with no expiry at all', async ({ request }) => {
      // jose only enforces `exp` when it is present, so a token without one
      // would otherwise be an immortal bearer credential. oauthIdentity
      // refuses it explicitly; this proves the deployed build does too.
      const idToken = await forgeToken(appleClaims(), null);
      const res = await exchange(request, { provider: 'apple', idToken });

      await expectForgeryRefused(res);
    });

    test('a token issued by somebody else entirely', async ({ request }) => {
      const idToken = await forgeToken(appleClaims({ iss: 'https://evil.example.com' }));
      const res = await exchange(request, { provider: 'apple', idToken });

      await expectForgeryRefused(res);
    });

    test('a token minted for a different audience', async ({ request }) => {
      // The confused-deputy case: a token some OTHER app legitimately holds.
      const idToken = await forgeToken(appleClaims({ aud: 'com.someone.else.app' }));
      const res = await exchange(request, { provider: 'apple', idToken });

      await expectForgeryRefused(res);
    });

    test('no refusal ever carries a session token', async ({ request }) => {
      const idToken = await forgeToken(appleClaims());
      const res = await exchange(request, { provider: 'apple', idToken });
      await expectForgeryRefused(res);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.token).toBeUndefined();
      expect(body.user).toBeUndefined();
      expect(res.headers()['set-cookie']).toBeUndefined();
    });

    test('a refusal says a code and nothing more', async ({ request }) => {
      // Verification failures are flattened into InvalidToken so that jose's
      // own message — which distinguishes "no matching key" from "bad
      // signature" — is not an oracle for someone probing the endpoint.
      const idToken = await forgeToken(appleClaims());
      const res = await exchange(request, { provider: 'apple', idToken });
      await expectForgeryRefused(res);
      const raw = await res.text();

      expect(raw).not.toMatch(/at\s+\w+\s+\(/); // no stack frames
      expect(raw.toLowerCase()).not.toContain('jwks');
      expect(raw.toLowerCase()).not.toContain('signature');
      expect(raw.length).toBeLessThan(200);
    });
  });

  test('the Google provider is configured on this deployment', async ({ request }) => {
    /**
     * Doubles as a config check, and that is the point. `AUTH_GOOGLE_IOS_CLIENT_ID`
     * is read per request and its absence returns 503 ProviderNotConfigured —
     * so an unset variable means every Google sign-in from the iOS app fails,
     * with no error anywhere on the web side to notice it by. A forged token
     * must get past that check and be refused on its merits: 401, not 503.
     *
     * If this fails with 503, the fix is to set AUTH_GOOGLE_IOS_CLIENT_ID in
     * the Vercel environment this suite is pointed at — not to relax the test.
     */
    const idToken = await forgeToken({
      iss: 'https://accounts.google.com',
      aud: 'e2e-forged-audience.apps.googleusercontent.com',
      sub: 'e2e-forged-subject',
      email: 'forged@e2e.feraltravels.com',
      email_verified: true,
    });
    const res = await exchange(request, { provider: 'google', idToken });

    const code = await errorCode(res);
    expect(
      code,
      'expected 401 InvalidToken; 503 ProviderNotConfigured means AUTH_GOOGLE_IOS_CLIENT_ID is unset on this deployment'
    ).not.toBe('ProviderNotConfigured');
    await expectForgeryRefused(res);
  });

  test('the route is POST-only', async ({ request }) => {
    const res = await request.get(EXCHANGE, { failOnStatusCode: false });

    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).not.toBe(200);
  });
});
