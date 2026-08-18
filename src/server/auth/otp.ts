import 'server-only';
import { db } from '@/server/db/client';
import { emailOtpCodes, users, sessions } from '@/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { isFixtureRecipient } from './test-endpoints';
import { renderOtpEmail } from './otp-email';
import { syncAdminFlagOnSignIn } from './admin';
import { cookies } from 'next/headers';

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds between sends

/** Generate a cryptographically random 6-digit code (zero-padded). */
export function generateOtpCode(): string {
  // Use crypto.getRandomValues for proper randomness.
  // We sample from 0–999999 uniformly; 1M is well within Uint32Array range
  // (max ~4.29B) so there's no meaningful modulo bias.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

/**
 * Store a freshly generated OTP code for `email`.
 * Deletes any existing codes for this address first so only one is ever valid.
 * Returns the age in ms of the most recently deleted code, or null if there
 * wasn't one — the caller can use this to enforce a resend cooldown.
 */
export async function storeOtpCode(email: string, code: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const expires = new Date(Date.now() + OTP_EXPIRY_MS);

  // Wipe old codes for this address (only one valid at a time).
  await db.delete(emailOtpCodes).where(eq(emailOtpCodes.email, normalized));

  await db.insert(emailOtpCodes).values({
    email: normalized,
    code,
    expires,
  });
}

/**
 * Returns the age in milliseconds of the existing pending OTP for `email`,
 * or null if no code exists. Used to enforce the resend cooldown.
 */
export async function getExistingOtpAgeMs(email: string): Promise<number | null> {
  const normalized = email.trim().toLowerCase();
  const rows = await db
    .select({ createdAt: emailOtpCodes.createdAt })
    .from(emailOtpCodes)
    .where(eq(emailOtpCodes.email, normalized))
    .limit(1);
  if (rows.length === 0) return null;
  return Date.now() - rows[0].createdAt.getTime();
}

/**
 * Validate a submitted OTP code for `email`.
 * - Returns `true` and deletes the code on a match.
 * - Returns `false` on wrong code (increments attempts counter).
 * - Returns `false` and deletes the code if expired or attempts exhausted.
 */
export async function verifyOtpCode(email: string, code: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const submitted = code.trim();

  const rows = await db
    .select()
    .from(emailOtpCodes)
    .where(eq(emailOtpCodes.email, normalized))
    .limit(1);

  if (rows.length === 0) return false;
  const row = rows[0];

  // Expired?
  if (row.expires < new Date()) {
    await db.delete(emailOtpCodes).where(eq(emailOtpCodes.id, row.id));
    return false;
  }

  // Too many wrong guesses?
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await db.delete(emailOtpCodes).where(eq(emailOtpCodes.id, row.id));
    return false;
  }

  // Wrong code → increment attempt count.
  if (row.code !== submitted) {
    await db
      .update(emailOtpCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(emailOtpCodes.id, row.id));
    return false;
  }

  // Correct → consume the code.
  await db.delete(emailOtpCodes).where(eq(emailOtpCodes.id, row.id));
  return true;
}

/**
 * Generate a code, store it, and email it to `email` via Resend.
 * Throws if Resend is not configured or the send fails.
 * Returns the generated code so callers can use it in test contexts.
 *
 * Enforces a 60-second cooldown between sends for the same address to prevent
 * abuse. Throws an error with message 'RateLimited' if the cooldown is active.
 */
export async function sendOtpCode(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();

  // Cooldown check.
  const ageMs = await getExistingOtpAgeMs(normalized);
  if (ageMs !== null && ageMs < OTP_RESEND_COOLDOWN_MS) {
    throw new Error('RateLimited');
  }

  const code = generateOtpCode();
  await storeOtpCode(normalized, code);

  // E2E fixture addresses (`playwright-*@e2e.feraltravels.com`, and only when
  // test endpoints are enabled — never on production) skip the TRANSPORT only.
  // The code above is already generated and stored; the spec reads it from
  // /api/test/otp and types it into the real verify UI, so the sign-in itself
  // is in no way shortened.
  //
  // Why not just let it send: that subdomain has no MX, so every send would
  // hard-bounce. Twelve bounces per CI run against the same domain the real
  // sign-in emails come from is a good way to get a sending reputation
  // wrecked — the same shape of problem as the disposable-inbox account that
  // got shut off. It also keeps CI off the 100-emails/day free-tier ceiling.
  //
  // COVERAGE NOTE: this means the eleven signed-in specs do not prove Resend
  // delivers. e2e/login-otp.spec.ts does, on every PR. Its address lives on a
  // Resend RECEIVING domain (E2E_INBOX_DOMAIN), which is NOT a fixture
  // address — so it falls straight through to the real send below, and the
  // code has to come back out of a mailbox before that spec can pass.
  if (isFixtureRecipient(normalized)) {
    // Still render, so a broken email template is a broken test rather than a
    // surprise in production.
    renderOtpEmail({ code, to: normalized, domain: undefined });
    return code;
  }

  const apiKey = process.env.AUTH_RESEND_KEY;
  if (!apiKey) {
    throw new Error('Email sign-in is not configured (missing AUTH_RESEND_KEY).');
  }

  const from = process.env.AUTH_EMAIL_FROM;
  if (!from) {
    throw new Error('Email sign-in is not configured (missing AUTH_EMAIL_FROM). Set it to a verified sender on your Resend domain.');
  }
  const resend = new Resend(apiKey);

  // Extract the domain from AUTH_URL or NEXTAUTH_URL for the origin-bound
  // one-time code line that Apple/Google use for auto-fill suggestions.
  const siteUrl = process.env.AUTH_URL || process.env.NEXTAUTH_URL || '';
  let domain: string | undefined;
  try {
    const parsed = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
    domain = parsed.hostname;
  } catch {
    // If we can't parse it, skip the origin-bound line — auto-fill just
    // won't get the domain hint but the email still works fine.
  }

  const result = await resend.emails.send({
    from,
    to: normalized,
    subject: `${code} is your Feral Travels sign-in code`,
    html: renderOtpEmail({ code, to: normalized, domain }),
    text: `Your Feral Travels sign-in code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.${domain ? `\n\n@${domain} #${code}` : ''}`,
  });

  if (result.error) {
    const msg = result.error.message || 'Unknown Resend error';
    console.error('[auth/otp] Resend send failed', { to: normalized, from, error: result.error });
    throw new Error(`EmailSendFailed: ${msg}`);
  }

  return code;
}

// Auth.js session cookie config. In production on HTTPS we use the
// __Secure- prefix + Secure flag. On HTTP (e.g. local `next start` for E2E)
// we must use the plain cookie name and secure: false or the browser never
// sends the cookie — middleware then bounces /trips → /login after OTP.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Whether to use Secure + __Secure- session cookies. Align with the actual
 * public URL: NODE_ENV alone is wrong for `next start` (always production)
 * hitting http://localhost — Secure cookies are not sent over HTTP.
 */
function useSecureSessionCookies(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  const raw = process.env.AUTH_URL || process.env.NEXTAUTH_URL || '';
  if (!raw.trim()) return true;
  const siteUrl = raw.startsWith('http') ? raw : `https://${raw}`;
  try {
    return new URL(siteUrl).protocol === 'https:';
  } catch {
    return true;
  }
}

function getSessionCookieName(): string {
  return useSecureSessionCookies()
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';
}

/**
 * Find-or-create the user for an ALREADY-VERIFIED email address, and mint a
 * database session row for them.
 *
 * "Already verified" is the caller's job and is the entire contract here: this
 * function asks no questions about HOW the address was proven — an emailed OTP
 * code, a Google ID token checked against Google's JWKS, an Apple identity
 * token. Every non-Auth.js sign-in path funnels through this one function on
 * purpose. If a second path grows its own copy, session lifetime, token
 * entropy, user-creation defaults and the emailVerified / admin-flag
 * bookkeeping drift apart, and the drift surfaces months later as a support
 * ticket ("my trips are gone") caused by a duplicate user row.
 *
 * `name` is display-only and is NEVER used for identity. It is written on
 * create and backfilled on an existing row only when that row has no name yet:
 * Apple hands the name over exactly once, on the user's first-ever
 * authorization for the app, so this is the single chance to record it — but
 * it must not clobber a name the user has set since.
 */
export async function createSessionForEmail(
  email: string,
  name?: string | null
): Promise<{ userId: string; sessionToken: string; expires: Date }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('createSessionForEmail requires an email address');
  const displayName = name?.trim() || null;

  // 1. Find or create the user row.
  const existing = await db
    .select({ id: users.id, name: users.name, emailVerified: users.emailVerified })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalized}`)
    .limit(1);

  let userId: string;

  if (existing.length > 0) {
    userId = existing[0].id;
    const patch: { emailVerified?: Date; name?: string } = {};
    if (!existing[0].emailVerified) patch.emailVerified = new Date();
    if (displayName && !existing[0].name) patch.name = displayName;
    if (Object.keys(patch).length > 0) {
      await db.update(users).set(patch).where(eq(users.id, userId));
    }
  } else {
    const [row] = await db
      .insert(users)
      .values({
        email: normalized,
        emailVerified: new Date(),
        ...(displayName ? { name: displayName } : {}),
      })
      .returning({ id: users.id });
    userId = row.id;
  }

  // Re-sync the admin flag on every sign-in (mirrors the signIn event handler).
  // Deliberately ONE call: the pre-refactor code ran this twice on the
  // create path (once in the branch, once after it), which was redundant —
  // it is idempotent and takes the same argument both times.
  await syncAdminFlagOnSignIn(normalized).catch(() => {});

  // 2. Create a database session.
  const sessionToken = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_MAX_AGE_MS);

  await db.insert(sessions).values({
    sessionToken,
    userId,
    expires,
  });

  return { userId, sessionToken, expires };
}

/**
 * Core OTP sign-in: verify the code, then hand off to createSessionForEmail.
 * Does NOT touch cookies — the caller decides how the session token reaches
 * the client:
 *   - Web (signInWithOtp): sets the Auth.js session cookie.
 *   - Mobile (/api/mobile/otp/verify): returns the token in the response body;
 *     the app stores it in secure storage and sends it as a Bearer header,
 *     which the guards resolve against the SAME sessions table.
 *
 * We bypass Auth.js's `signIn('credentials', ...)` because the Credentials
 * provider does NOT work with `session: { strategy: 'database' }` — it only
 * supports JWT sessions. So we handle the database session ourselves.
 *
 * Returns the session on success, or null if the code is invalid/expired.
 */
export async function signInWithOtpCore(
  email: string,
  code: string
): Promise<{ userId: string; sessionToken: string; expires: Date } | null> {
  const normalized = email.trim().toLowerCase();
  const submitted = code.trim();
  if (!normalized || !submitted) return null;

  const valid = await verifyOtpCode(normalized, submitted);
  if (!valid) return null;

  return createSessionForEmail(normalized);
}

/**
 * Full web OTP sign-in: core flow + set the Auth.js session cookie.
 * Returns the userId on success, or null if the code is invalid/expired.
 */
export async function signInWithOtp(email: string, code: string): Promise<string | null> {
  const result = await signInWithOtpCore(email, code);
  if (!result) return null;

  // Set the session cookie so Auth.js picks it up.
  const cookieStore = await cookies();
  const secure = useSecureSessionCookies();
  cookieStore.set(getSessionCookieName(), result.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: result.expires,
  });

  return result.userId;
}
