import 'server-only';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { sanitizeAvatarUrl } from '@/lib/avatarUrl';
import { isProviderEmailProven } from './emailVerification';
import { HttpError, UnauthorizedError } from './errors';

/**
 * Verification of native (iOS) OAuth identity tokens.
 *
 * Split out of the route handler so it can be unit-tested without booting a
 * Next.js request: the route is a thin shell over `verifyIdentityToken`.
 *
 * The mobile client is NOT trusted. Anyone can POST /api/mobile/oauth/exchange
 * with a hand-written JWT claiming to be any email on earth, so the signature
 * is checked against the provider's published keys before a single claim is
 * read.
 */

/**
 * `createRemoteJWKSet` at module scope on purpose: it caches the key set and
 * refetches on rotation, so this costs one network round trip per cold start
 * rather than one per sign-in — and it survives Google's and Apple's periodic
 * key rollover without a deploy.
 */
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

/** Google issues `iss` in both forms depending on the client. Both are valid. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * Apple's audience is the app's BUNDLE ID, not an OAuth client id — the native
 * "Sign in with Apple" flow has no separate client registration. (The web flow
 * uses a Services ID instead, but that one goes through Auth.js and never
 * reaches this route.) Overridable so a rename of the bundle id is an env
 * change, not a deploy of a new constant.
 */
const APPLE_AUDIENCE = process.env.APPLE_APP_BUNDLE_ID || 'com.feraltravels.app';

export type OAuthProvider = 'google' | 'apple';

export interface VerifiedIdentity {
  email: string;
  name?: string;
  /**
   * The Google profile photo URL, already run through `sanitizeAvatarUrl` —
   * so it is either a `*.googleusercontent.com` https URL or absent, never
   * whatever string the token happened to carry. Absent for Apple, always:
   * the Apple ID token has no `picture` claim.
   */
  picture?: string;
  /**
   * The token's own `exp`, surfaced so the caller's replay guard can keep its
   * record exactly as long as the token could still be presented — no longer,
   * no shorter. A token with no `exp` is rejected outright below: jose only
   * enforces the claim when it is present, and a never-expiring bearer
   * credential is not something to be lenient about.
   */
  expiresAt: Date;
}

/** Shared: a token with no usable `exp` is not something to mint a session from. */
function expiryFrom(payload: JWTPayload): Date {
  if (typeof payload.exp !== 'number') throw new UnauthorizedError('InvalidToken');
  return new Date(payload.exp * 1000);
}

/** Deps seam so the tests can inject a verifier instead of hitting the network. */
export interface VerifyDeps {
  verify?: (
    token: string,
    jwks: ReturnType<typeof createRemoteJWKSet>,
    options: { issuer: string | string[]; audience: string; clockTolerance: number }
  ) => Promise<{ payload: JWTPayload }>;
}

const defaultVerify: NonNullable<VerifyDeps['verify']> = (token, jwks, options) =>
  jwtVerify(token, jwks, options);

/**
 * Why verification failed — to the SERVER LOG only.
 *
 * The client answer stays a flat `InvalidToken` on purpose: jose distinguishes
 * "no matching key" from "bad signature" from "expired", and handing that
 * difference to a caller probing the endpoint is an oracle. But flattening it
 * in the logs too means an outage and an attack look identical. A JWKS fetch
 * that never completes (`ERR_JWKS_TIMEOUT`, a DNS failure) breaks EVERY real
 * sign-in while the e2e suite stays green, because a forged token and an
 * unreachable provider both end here.
 *
 * Codes only. Never the token — it is a live bearer credential — and never the
 * payload.
 */
function logVerificationFailure(provider: OAuthProvider, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`[oauth] ${provider} id-token verification failed: ${String(code ?? name)}`);
}

function claimString(payload: JWTPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function verifyGoogle(idToken: string, deps: VerifyDeps): Promise<VerifiedIdentity> {
  /**
   * The iOS client id — deliberately NOT the web `AUTH_GOOGLE_ID`. Accepting a
   * token minted for a different client is the classic confused-deputy
   * audience bug: any app the user has ever signed into with Google could
   * present its own ID token here and be handed a session as that user.
   */
  const audience = process.env.AUTH_GOOGLE_IOS_CLIENT_ID;
  if (!audience) {
    // 503, not 500: nothing is broken, the provider just isn't set up in this
    // environment yet. The app maps this code to "use your email instead".
    throw new HttpError(503, 'ProviderNotConfigured');
  }

  let payload: JWTPayload;
  try {
    // jwtVerify enforces the signature plus `exp` / `nbf`; issuer and audience
    // are checked here rather than after the fact, so a bad token never
    // reaches the claim-reading code below.
    ({ payload } = await (deps.verify ?? defaultVerify)(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience,
      clockTolerance: 5,
    }));
  } catch (err) {
    logVerificationFailure('google', err);
    throw new UnauthorizedError('InvalidToken');
  }

  const email = claimString(payload, 'email');
  if (!email) throw new UnauthorizedError('InvalidToken');

  /**
   * An unverified Google address is an address the holder may not own, and
   * this route's whole contract is "verified email == account identity".
   * Without this check, anyone could create a Google account claiming someone
   * else's address and take over their trips.
   */
  if (!isProviderEmailProven('google', payload['email_verified'], email)) {
    throw new UnauthorizedError('EmailNotVerified');
  }

  return {
    email: email.toLowerCase(),
    name: claimString(payload, 'name') ?? undefined,
    /**
     * The avatar rides along on the SAME verified token as the address, so it
     * is as trustworthy as the identity itself — but the URL inside it is
     * still a third-party string, so it goes through the host allowlist
     * before anyone stores or renders it. A claim that fails the check is
     * dropped silently; the UI falls back to the generic glyph.
     */
    picture: sanitizeAvatarUrl(payload['picture']) ?? undefined,
    expiresAt: expiryFrom(payload),
  };
}

async function verifyApple(
  idToken: string,
  fullName: string | null | undefined,
  deps: VerifyDeps
): Promise<VerifiedIdentity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await (deps.verify ?? defaultVerify)(idToken, APPLE_JWKS, {
      issuer: APPLE_ISSUER,
      audience: APPLE_AUDIENCE,
      clockTolerance: 5,
    }));
  } catch (err) {
    logVerificationFailure('apple', err);
    throw new UnauthorizedError('InvalidToken');
  }

  const email = claimString(payload, 'email');
  if (!email) throw new UnauthorizedError('InvalidToken');

  /**
   * Apple's `email_verified` handling, deliberately NOT symmetric with
   * Google's — but far narrower than "advisory".
   *
   * An earlier revision here rejected only an explicit `false`, so a token
   * that simply OMITTED the claim minted a session for whatever address it
   * carried. That matters because createSessionForEmail links by email onto
   * an existing OTP user and stamps users.emailVerified, which is in turn a
   * precondition of the admin guard — so an unasserted address could inherit
   * a real account. Apple asserting nothing is not Apple asserting yes.
   *
   * The one genuine exception is the Hide My Email alias: Apple owns and
   * routes @privaterelay.appleid.com, so such an address is Apple-proven by
   * construction and there is no other party who could claim it. Scope the
   * leniency to exactly that domain rather than to every Apple token.
   */
  const lowered = email.toLowerCase();
  if (!isProviderEmailProven('apple', payload['email_verified'], lowered)) {
    throw new UnauthorizedError('EmailNotVerified');
  }

  /**
   * Apple's token carries no name claim, ever, and the client can only send a
   * name on the user's first authorization — so this is the single chance to
   * record it. Display-only; never used for identity.
   */
  const name = fullName?.trim() || undefined;

  return { email: lowered, name, expiresAt: expiryFrom(payload) };
}

export function verifyIdentityToken(
  provider: OAuthProvider,
  idToken: string,
  fullName: string | null | undefined,
  deps: VerifyDeps = {}
): Promise<VerifiedIdentity> {
  return provider === 'google'
    ? verifyGoogle(idToken, deps)
    : verifyApple(idToken, fullName, deps);
}
