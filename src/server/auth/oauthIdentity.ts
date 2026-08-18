import 'server-only';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
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

function claimString(payload: JWTPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Providers are inconsistent: `email_verified` arrives as boolean or "true". */
function claimIsTrue(payload: JWTPayload, key: string): boolean {
  const value = payload[key];
  return value === true || value === 'true';
}

async function verifyGoogle(idToken: string, deps: VerifyDeps): Promise<VerifiedIdentity> {
  /**
   * The iOS client id — deliberately NOT the web `AUTH_GOOGLE_ID`. Accepting a
   * token minted for a different client is the classic confused-deputy
   * audience bug: any app the user has ever signed into with Google could
   * present its own ID token here and be handed a session as that user.
   */
  const audience = process.env.GOOGLE_IOS_CLIENT_ID;
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
  } catch {
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
  if (!claimIsTrue(payload, 'email_verified')) {
    throw new UnauthorizedError('EmailNotVerified');
  }

  return { email: email.toLowerCase(), name: claimString(payload, 'name') ?? undefined };
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
  } catch {
    throw new UnauthorizedError('InvalidToken');
  }

  const email = claimString(payload, 'email');
  if (!email) throw new UnauthorizedError('InvalidToken');

  /**
   * Apple only puts `email_verified` on the token for real (non-relay)
   * addresses in some flows, but every address Apple returns — including a
   * `@privaterelay.appleid.com` alias — is one Apple has already proven the
   * user controls. Treat the claim as advisory: reject only an explicit
   * `false`, rather than requiring a claim Apple may simply omit.
   */
  const verified = payload['email_verified'];
  if (verified === false || verified === 'false') {
    throw new UnauthorizedError('EmailNotVerified');
  }

  /**
   * Apple's token carries no name claim, ever, and the client can only send a
   * name on the user's first authorization — so this is the single chance to
   * record it. Display-only; never used for identity.
   */
  const name = fullName?.trim() || undefined;

  return { email: email.toLowerCase(), name };
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
