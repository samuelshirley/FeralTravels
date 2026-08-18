/**
 * The native OAuth exchange is the one place where a stranger's bytes decide
 * who you are signed in as, so these tests are about REFUSAL more than about
 * the happy path.
 *
 * jose's `jwtVerify` is injected rather than mocked at the module level: the
 * real signature check is jose's job and is well tested upstream, while what
 * WE have to get right is which options we hand it (audience above all) and
 * what we do with the claims that come back.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { verifyIdentityToken, type VerifyDeps } from './oauthIdentity';
import { HttpError } from './errors';

const IOS_CLIENT = '111-ios.apps.googleusercontent.com';
const WEB_CLIENT = '222-web.apps.googleusercontent.com';

/** Records the options we passed jose, and returns the claims we dictate. */
function verifierReturning(payload: Record<string, unknown>) {
  const calls: Array<{ issuer: string | string[]; audience: string; clockTolerance: number }> = [];
  const verify: VerifyDeps['verify'] = async (_token, _jwks, options) => {
    calls.push(options);
    return { payload };
  };
  return { verify, calls };
}

/** Stands in for jose rejecting a bad signature / expiry / audience. */
const rejectingVerifier: VerifyDeps['verify'] = async () => {
  throw new Error('JWSSignatureVerificationFailed');
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.GOOGLE_IOS_CLIENT_ID = IOS_CLIENT;
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
    delete process.env.GOOGLE_IOS_CLIENT_ID;
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
    expect(calls[0].audience).toBe('com.feraltravels.app');
    expect(calls[0].issuer).toBe('https://appleid.apple.com');
  });

  it('accepts a private-relay address with no email_verified claim', async () => {
    // Apple omits the claim in some flows. Every address Apple returns is one
    // it has already proven the user controls, relay alias included, so
    // requiring the claim would lock out real users.
    const { verify } = verifierReturning({ email: 'abc123@privaterelay.appleid.com' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify })).resolves.toEqual({
      email: 'abc123@privaterelay.appleid.com',
      name: undefined,
    });
  });

  it('still refuses an explicit email_verified: false', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com', email_verified: 'false' });
    await expect(verifyIdentityToken('apple', 'tok', null, { verify })).rejects.toMatchObject({
      message: 'EmailNotVerified',
    });
  });

  it('takes the name from the client, not the token, and only once', async () => {
    // Apple never puts a name in the token; the client can only send one on
    // the user's first-ever authorization.
    const { verify } = verifierReturning({ email: 'a@b.com', name: 'Token Name' });
    await expect(
      verifyIdentityToken('apple', 'tok', '  Sam Shirley  ', { verify })
    ).resolves.toEqual({ email: 'a@b.com', name: 'Sam Shirley' });
  });

  it('treats a whitespace-only name as no name', async () => {
    const { verify } = verifierReturning({ email: 'a@b.com' });
    await expect(verifyIdentityToken('apple', 'tok', '   ', { verify })).resolves.toEqual({
      email: 'a@b.com',
      name: undefined,
    });
  });

  it('does not fall back to the Google client id for its audience', async () => {
    // A copy-paste of the Google branch would silently accept Apple tokens
    // aimed at a Google client — and vice versa.
    const { verify, calls } = verifierReturning({ email: 'a@b.com' });
    await verifyIdentityToken('apple', 'tok', null, { verify });
    expect(calls[0].audience).not.toBe(IOS_CLIENT);
  });
});
