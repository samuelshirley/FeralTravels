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

import { verifyIdentityToken, type VerifyDeps } from './oauthIdentity';
import { HttpError } from './errors';

const IOS_CLIENT = '111-ios.apps.googleusercontent.com';
const WEB_CLIENT = '222-web.apps.googleusercontent.com';
const APPLE_AUDIENCE = 'com.feraltravels.app';

/** Far-future, fixed, so `expiresAt` assertions do not depend on the clock. */
const EXP = 1893456000; // 2030-01-01T00:00:00Z
const EXPECTED_EXPIRY = new Date(EXP * 1000);

/** Records the options we passed jose, and returns the claims we dictate. */
function verifierReturning(payload: Record<string, unknown>) {
  const calls: Array<{ issuer: string | string[]; audience: string; clockTolerance: number }> = [];
  const verify: VerifyDeps['verify'] = async (_token, _jwks, options) => {
    calls.push(options);
    // Every real provider token carries `exp`; default it here so each test
    // only has to state the claim it is actually about.
    return { payload: { exp: EXP, ...payload } };
  };
  return { verify, calls };
}

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
    await expect(verifyIdentityToken('google', 'tok', null, { verify })).resolves.toEqual({
      email: 'sam@example.com',
      name: 'Sam Shirley',
      expiresAt: EXPECTED_EXPIRY,
    });
  });

  it('verifies against the iOS client id, NEVER the web one', async () => {
    // The confused-deputy bug: if this route accepted tokens minted for the
    // web client (or any other client), any app holding a Google token for
    // this user could present it here and be handed their session.
    const { verify, calls } = verifierReturning({ email: 'a@b.com', email_verified: true });
    await verifyIdentityToken('google', 'tok', null, { verify });

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
    await expect(verifyIdentityToken('google', 'tok', null, { verify })).rejects.toMatchObject({
      status: 401,
      message: 'EmailNotVerified',
    });
  });

  it('refuses a token with no email_verified claim at all', async () => {
    const { verify } = verifierReturning({ email: 'victim@example.com' });
    await expect(verifyIdentityToken('google', 'tok', null, { verify })).rejects.toMatchObject({
      message: 'EmailNotVerified',
    });
  });

  it('accepts the string "true" (providers are inconsistent about the type)', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: 'true' });
    await expect(verifyIdentityToken('google', 'tok', null, { verify })).resolves.toMatchObject({
      email: 'a@b.com',
    });
  });

  it('turns any verification failure into a flat 401, leaking nothing', async () => {
    await expect(
      verifyIdentityToken('google', 'tok', null, { verify: rejectingVerifier })
    ).rejects.toMatchObject({ status: 401, message: 'InvalidToken' });
  });

  it('refuses a token that carries no email claim', async () => {
    const { verify } = verifierReturning({ email_verified: true, name: 'No Email' });
    await expect(verifyIdentityToken('google', 'tok', null, { verify })).rejects.toMatchObject({
      status: 401,
      message: 'InvalidToken',
    });
  });

  it('reports 503 ProviderNotConfigured when the iOS client id is unset', async () => {
    // The pre-launch state: the app hides its Google button, but a stale build
    // could still reach here. Nothing is broken — it just is not set up.
    delete process.env.AUTH_GOOGLE_IOS_CLIENT_ID;
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: true });
    const err = await verifyIdentityToken('google', 'tok', null, { verify }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 503, message: 'ProviderNotConfigured' });
  });
});

describe('Apple identity tokens', () => {
  it('verifies against the app bundle id and Apple issuer', async () => {
    const { verify, calls } = verifierReturning({ email: 'sam@privaterelay.appleid.com' });
    await verifyIdentityToken('apple', 'tok', null, { verify });
    expect(calls[0].audience).toBe(APPLE_AUDIENCE);
    expect(calls[0].issuer).toBe('https://appleid.apple.com');
  });

  it('accepts a private-relay address with no email_verified claim', async () => {
    // The ONE case where an absent claim is acceptable: Apple owns and routes
    // @privaterelay.appleid.com, so nobody else could be claiming it.
    const { verify } = verifierReturning({ email: 'abc123@privaterelay.appleid.com' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify })).resolves.toEqual({
      email: 'abc123@privaterelay.appleid.com',
      name: undefined,
      expiresAt: EXPECTED_EXPIRY,
    });
  });

  it('REFUSES a real address with no email_verified claim', async () => {
    // The regression this test exists for: an earlier revision rejected only
    // an explicit `false`, so a token that merely omitted the claim minted a
    // session. createSessionForEmail links by email onto an existing OTP user
    // and stamps users.emailVerified, which the admin guard keys off — so an
    // address Apple never asserted could inherit a real account.
    const { verify } = verifierReturning({ email: 'victim@example.com' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify })).rejects.toMatchObject({
      status: 401,
      message: 'EmailNotVerified',
    });
  });

  it('accepts a real address when Apple does assert the claim', async () => {
    const { verify } = verifierReturning({ email: 'sam@example.com', email_verified: 'true' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify })).resolves.toMatchObject({
      email: 'sam@example.com',
    });
  });

  it('still refuses an explicit email_verified: false', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: 'false' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify })).rejects.toMatchObject({
      message: 'EmailNotVerified',
    });
  });

  it('does not treat a lookalike relay domain as Apple-owned', async () => {
    const { verify } = verifierReturning({ email: 'a@privaterelay.appleid.com.evil.test' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify })).rejects.toMatchObject({
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
      verifyIdentityToken('apple', 'tok', '  Sam Shirley  ', { verify })
    ).resolves.toMatchObject({ email: 'a@b.com', name: 'Sam Shirley' });
  });

  it('treats a whitespace-only name as no name', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: true });
    await expect(
      verifyIdentityToken('apple', 'tok', '   ', { verify })
    ).resolves.toMatchObject({ email: 'a@b.com', name: undefined });
  });

  it('does not fall back to the Google client id for its audience', async () => {
    // A copy-paste of the Google branch would silently accept Apple tokens
    // aimed at a Google client — and vice versa.
    const { verify, calls } = verifierReturning({ email: 'a@b.com', email_verified: true });
    await verifyIdentityToken('apple', 'tok', null, { verify });
    expect(calls[0].audience).not.toBe(IOS_CLIENT);
  });
});

describe('token expiry', () => {
  it('surfaces the token exp so the replay guard can bound its record', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: true });
    const identity = await verifyIdentityToken('google', 'tok', null, { verify });
    expect(identity.expiresAt).toEqual(EXPECTED_EXPIRY);
  });

  it('refuses a token with no exp — a bearer credential that never dies', async () => {
    const verify: VerifyDeps['verify'] = async () => ({
      payload: { email: 'a@b.com', email_verified: true },
    });
    await expect(verifyIdentityToken('google', 'tok', null, { verify })).rejects.toMatchObject({
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
    await expect(verifyIdentityToken('google', token, null, { verify })).resolves.toMatchObject({
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
    await expect(verifyIdentityToken('google', token, null, { verify })).rejects.toMatchObject({
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
    await expect(verifyIdentityToken('google', token, null, { verify })).rejects.toMatchObject({
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
    await expect(verifyIdentityToken('google', forged, null, { verify })).rejects.toMatchObject({
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
    await expect(verifyIdentityToken('google', stale, null, { verify })).rejects.toMatchObject({
      message: 'InvalidToken',
    });
  });
});
