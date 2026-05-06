import 'server-only';
import { db } from '@/server/db/client';
import { emailOtpCodes } from '@/server/db/schema';
import { eq } from 'drizzle-orm';
import { Resend } from 'resend';
import { renderOtpEmail } from './otp-email';

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

  const apiKey = process.env.AUTH_RESEND_KEY;
  if (!apiKey) {
    throw new Error('Email sign-in is not configured (missing AUTH_RESEND_KEY).');
  }

  const from = process.env.AUTH_EMAIL_FROM;
  if (!from) {
    throw new Error('Email sign-in is not configured (missing AUTH_EMAIL_FROM). Set it to a verified sender on your Resend domain.');
  }
  const resend = new Resend(apiKey);

  const result = await resend.emails.send({
    from,
    to: normalized,
    subject: 'Your Feral Travels sign-in code',
    html: renderOtpEmail({ code, to: normalized }),
    text: `Your Feral Travels sign-in code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request this, you can ignore this email.`,
  });

  if (result.error) {
    const msg = result.error.message || 'Unknown Resend error';
    console.error('[auth/otp] Resend send failed', { to: normalized, from, error: result.error });
    throw new Error(`EmailSendFailed: ${msg}`);
  }

  return code;
}
