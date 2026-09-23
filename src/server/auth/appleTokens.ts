import 'server-only';
import { SignJWT, decodeJwt, importPKCS8 } from 'jose';
import { APPLE_AUDIENCE } from './oauthIdentity';
import { ATTEMPT_TIMEOUT_MS, LIVE_BUDGET_MS, RETRY_DELAYS_MS } from './jwksSource';

/**
 * Sign in with Apple's REST side: turn the app's authorization code into a
 * refresh token at sign-in, and revoke that token when the account is deleted.
 *
 * WHY. App Review 5.1.1(v): an app offering Sign in with Apple must revoke the
 * user's tokens through Apple's REST API when they delete their account. The
 * identity token the exchange route verifies cannot be revoked — only a
 * refresh (or access) token can, and the only way to get one is to redeem the
 * single-use authorization code the app receives alongside the identity
 * token. So sign-in redeems it (`exchangeAuthorizationCode`), the exchange
 * route stores the result encrypted in `accounts`, and `deleteAccount.ts`
 * revokes it (`revokeRefreshToken`).
 *
 * NEITHER CALL MAY BREAK ITS CALLER. Every failure comes back as a typed
 * `{ ok: false }` result, never a throw: a sign-in that cannot store a token
 * still signs in, and a deletion whose revoke fails still deletes. The caller
 * logs the result to /admin/errors.
 *
 * SECRETS NEVER REACH A LOG LINE. Not the code, the refresh token, the client
 * secret or the key — only HTTP statuses and Apple's own `error` field (e.g.
 * `invalid_grant`), which is a fixed vocabulary.
 *
 * CONFIGURATION: `APPLE_SIGNIN_KEY_ID` + `APPLE_SIGNIN_PRIVATE_KEY` (a Sign in
 * with Apple key's .p8 contents), optional `APPLE_TEAM_ID`. Missing → the
 * typed `not_configured` result, so sign-in and deletion keep working with a
 * logged failure until the key is on Vercel.
 */

export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

/** Public already — it is in `mobile/eas.json`. */
export const DEFAULT_APPLE_TEAM_ID = 'TJX3F3832H';

/** The client secret is minted per call, so it only needs to outlive one request. */
export const CLIENT_SECRET_TTL_S = 300;

/**
 * Three attempts in all, paced by `jwksSource.ts`'s measured policy: the
 * 2026-09-21 404s came from Apple's front end on this same host, chosen per
 * request, and a pause is what gets past them.
 */
export const MAX_ATTEMPTS = 3;

export type AppleFailureReason =
  | 'not_configured'
  /** Apple answered, and said no (an `error` field, e.g. invalid_grant). */
  | 'apple_error'
  /** Every attempt failed on transport: non-200 without a verdict, timeout, network. */
  | 'unavailable'
  /** A 200 we could not use. */
  | 'malformed';

export interface AppleFailure {
  ok: false;
  reason: AppleFailureReason;
  /** Safe to log: statuses and Apple error codes only. */
  detail: string;
}

export type AppleExchangeResult = { ok: true; refreshToken: string; sub: string } | AppleFailure;
export type AppleRevokeResult = { ok: true } | AppleFailure;

export interface AppleTokenDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

interface Resolved {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}

function resolve(deps: AppleTokenDeps): Resolved {
  return {
    // Looked up per call: Next patches the global fetch at startup.
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    env: deps.env ?? process.env,
    log: deps.log ?? ((line: string) => console.error(line)),
  };
}

/**
 * A .p8 pasted into a Vercel field arrives either with real newlines or with
 * literal `\n` escapes, depending on how it was pasted. Both are accepted, as
 * is the bare base64 body without the PEM armour.
 */
export function normalizePrivateKey(raw: string): string {
  const unescaped = raw.replace(/\\n/g, '\n').trim();
  if (unescaped.includes('-----BEGIN')) return unescaped;
  const body = unescaped.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----'].join('\n');
}

/**
 * The ES256 client secret Apple wants in place of a static one: header `kid`,
 * issuer = team, subject = the client id (the bundle id), audience Apple.
 * Five minutes, because it is minted for exactly one request.
 */
export async function mintClientSecret(
  deps: AppleTokenDeps = {}
): Promise<{ ok: true; secret: string } | AppleFailure> {
  const { env, now } = resolve(deps);
  const keyId = env.APPLE_SIGNIN_KEY_ID?.trim();
  const rawKey = env.APPLE_SIGNIN_PRIVATE_KEY?.trim();
  const missing = [!keyId && 'APPLE_SIGNIN_KEY_ID', !rawKey && 'APPLE_SIGNIN_PRIVATE_KEY'].filter(
    Boolean
  );
  if (!keyId || !rawKey) {
    return { ok: false, reason: 'not_configured', detail: `not configured: ${missing.join(', ')} unset` };
  }

  let key: CryptoKey;
  try {
    key = await importPKCS8(normalizePrivateKey(rawKey), 'ES256');
  } catch {
    // Never echo the key or jose's message about it.
    return {
      ok: false,
      reason: 'not_configured',
      detail: 'not configured: APPLE_SIGNIN_PRIVATE_KEY is not a PKCS8 EC P-256 key',
    };
  }

  const iat = Math.floor(now() / 1000);
  const secret = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(env.APPLE_TEAM_ID?.trim() || DEFAULT_APPLE_TEAM_ID)
    .setIssuedAt(iat)
    .setExpirationTime(iat + CLIENT_SECRET_TTL_S)
    .setAudience('https://appleid.apple.com')
    .setSubject(APPLE_AUDIENCE)
    .sign(key);
  return { ok: true, secret };
}

/** Name and code only: a driver error's message can quote a statement's values. */
function errorLabel(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return code === undefined ? name : `${name} ${String(code)}`;
}

function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const code =
    (err as { cause?: { code?: unknown } } | null)?.cause?.code ??
    (err as { code?: unknown } | null)?.code;
  return `network ${String(code ?? name)}`;
}

/** Apple's `error` field, only if it looks like one of its codes — never free text. */
async function appleErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}

type Attempt = { res: Response } | { failure: string; final: boolean };

/**
 * POST a form to Apple with the retry policy. A 400/401 carrying an `error`
 * is Apple's verdict on the request (invalid_grant, invalid_client) and is
 * final — asking again gets the same answer. Anything else non-200 is the
 * front end, and is retried.
 */
async function postWithRetry(
  url: string,
  form: Record<string, string>,
  label: string,
  r: Resolved
): Promise<{ ok: true; res: Response } | AppleFailure> {
  const started = r.now();
  const failures: string[] = [];

  async function attempt(timeoutMs: number): Promise<Attempt> {
    let res: Response;
    try {
      res = await r.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { failure: describeError(err), final: false };
    }
    if (res.status === 200) return { res };
    const code = await appleErrorCode(res);
    const final = code !== null && (res.status === 400 || res.status === 401);
    return { failure: `http ${res.status}${code ? ` ${code}` : ''}`, final };
  }

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i > 0) {
      const pause = RETRY_DELAYS_MS[i - 1] * (0.5 + Math.random());
      if (r.now() - started + pause >= LIVE_BUDGET_MS) break;
      await r.sleep(pause);
    }
    const remaining = LIVE_BUDGET_MS - (r.now() - started);
    if (remaining <= 0) break;
    const result = await attempt(Math.min(ATTEMPT_TIMEOUT_MS, remaining));
    if ('res' in result) {
      if (failures.length > 0) {
        r.log(`[apple] ${label}: succeeded on attempt ${i + 1} after ${failures.join(', ')}`);
      }
      return { ok: true, res: result.res };
    }
    failures.push(result.failure);
    if (result.final) {
      return { ok: false, reason: 'apple_error', detail: failures.join(', ') };
    }
  }
  return { ok: false, reason: 'unavailable', detail: failures.join(', ') };
}

/**
 * Redeem the app's authorization code for a refresh token. The `sub` comes
 * from the returned id_token, which arrived from Apple over TLS in answer to
 * our own client secret, so it is decoded rather than re-verified.
 *
 * A code is single-use and lives five minutes. The app's exchange retry can
 * resend the same code, which Apple answers `invalid_grant` — logged, and the
 * sign-in proceeds.
 */
export async function exchangeAuthorizationCode(
  code: string,
  deps: AppleTokenDeps = {}
): Promise<AppleExchangeResult> {
  const r = resolve(deps);
  const secret = await mintClientSecret(deps);
  if (!secret.ok) return secret;

  const posted = await postWithRetry(
    APPLE_TOKEN_URL,
    {
      client_id: APPLE_AUDIENCE,
      client_secret: secret.secret,
      code,
      grant_type: 'authorization_code',
    },
    'token exchange',
    r
  );
  if (!posted.ok) return posted;

  let body: { refresh_token?: unknown; id_token?: unknown };
  try {
    body = (await posted.res.json()) as typeof body;
  } catch {
    return { ok: false, reason: 'malformed', detail: 'http 200 with a body that is not JSON' };
  }
  if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
    return { ok: false, reason: 'malformed', detail: 'http 200 without a refresh_token' };
  }
  let sub: unknown;
  try {
    sub = typeof body.id_token === 'string' ? decodeJwt(body.id_token).sub : undefined;
  } catch {
    sub = undefined;
  }
  if (typeof sub !== 'string' || sub.length === 0) {
    return { ok: false, reason: 'malformed', detail: 'http 200 without a usable id_token sub' };
  }
  return { ok: true, refreshToken: body.refresh_token, sub };
}

/** Revoke a refresh token. HTTP 200 is success — Apple sends no body. */
export async function revokeRefreshToken(
  token: string,
  deps: AppleTokenDeps = {}
): Promise<AppleRevokeResult> {
  const r = resolve(deps);
  const secret = await mintClientSecret(deps);
  if (!secret.ok) return secret;

  const posted = await postWithRetry(
    APPLE_REVOKE_URL,
    {
      client_id: APPLE_AUDIENCE,
      client_secret: secret.secret,
      token,
      token_type_hint: 'refresh_token',
    },
    'revoke',
    r
  );
  if (!posted.ok) return posted;
  await posted.res.body?.cancel().catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sign-in side: redeem, check, encrypt, store — and never fail the sign-in.
// ---------------------------------------------------------------------------

export interface CaptureDeps {
  exchange?: (code: string) => Promise<AppleExchangeResult>;
  encrypt?: (plaintext: string) => string | null;
  store?: (userId: string, sub: string, encrypted: string) => Promise<void>;
  logFailure?: (userId: string, errorMessage: string) => Promise<void>;
}

/**
 * The repo, the crypto and the usage log are imported lazily, like
 * `jwksSource.ts`'s store, so this module's unit tests never load the
 * database client.
 */
const defaultCaptureDeps: Required<Omit<CaptureDeps, 'encrypt'>> = {
  exchange: (code) => exchangeAuthorizationCode(code),
  store: async (userId, sub, encrypted) => {
    const { storeAppleRefreshToken } = await import('@/server/repos/appleTokens');
    await storeAppleRefreshToken(userId, sub, encrypted);
  },
  logFailure: async (userId, errorMessage) => {
    const { logUsageEvent } = await import('@/server/repos/usage');
    await logUsageEvent({
      userId,
      provider: 'apple:token-exchange',
      success: false,
      errorMessage,
    });
  },
};

/**
 * After a native Apple sign-in has minted its session: redeem the code, check
 * the refresh token belongs to the SAME Apple user the identity token named,
 * and store it encrypted for `deleteAccount` to revoke.
 *
 * Returns what happened; never throws, never rejects. Every failure is logged
 * to `usage_events` as `apple:token-exchange`, and that write's own failure
 * goes to the console — the fuel.ts `failLeg` pattern.
 *
 * Awaited by the route rather than left floating: a serverless function can
 * be frozen the moment its response is sent, taking an unawaited write with it.
 */
export async function captureAppleRefreshToken(
  input: { userId: string; identitySub: string; authorizationCode: string },
  deps: CaptureDeps = {}
): Promise<'stored' | 'failed'> {
  const exchange = deps.exchange ?? defaultCaptureDeps.exchange;
  const store = deps.store ?? defaultCaptureDeps.store;
  const logFailure = deps.logFailure ?? defaultCaptureDeps.logFailure;

  const fail = async (message: string): Promise<'failed'> => {
    try {
      await logFailure(input.userId, message.slice(0, 500));
    } catch (e) {
      console.error('[apple] failed to log token-exchange failure to usage_events:', errorLabel(e));
    }
    return 'failed';
  };

  try {
    const result = await exchange(input.authorizationCode);
    if (!result.ok) return await fail(result.detail);

    // The code came from the client, so it is as untrusted as anything else
    // the client sends. A code from a DIFFERENT Apple user redeems fine at
    // Apple; storing its token here would let deletion revoke someone else's.
    if (result.sub !== input.identitySub) {
      return await fail('refresh token sub does not match the identity token sub; not stored');
    }

    const encrypt =
      deps.encrypt ?? (await import('@/server/deletedUserCrypto')).encryptSecret;
    const encrypted = encrypt(result.refreshToken);
    if (!encrypted) return await fail('no encryption key');

    await store(input.userId, result.sub, encrypted);
    return 'stored';
  } catch (err) {
    return fail(`could not store the refresh token: ${errorLabel(err)}`);
  }
}
