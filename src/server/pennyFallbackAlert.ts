import 'server-only';
import { Resend } from 'resend';
import type { PennyFallback } from '@/lib/penny/fallback';
import { adminAlertRecipients } from '@/server/auth/admin';
import { countUsageEventsSince, logUsageEvent } from '@/server/repos/usage';

/**
 * A user's turn ended on "Sorry, I couldn't apply that cleanly — could you
 * rephrase and try again?": no tool call, nothing applied, no text left. Sam
 * has never seen it himself, but PR 90's CI hit it once on the onboarding
 * hand-off (run 39604238894) — the first plan a new user, or App Review, ever
 * asks for — and the only record went with the preview database.
 *
 * So every occurrence is:
 *  1. a `penny:fallback` row in usage_events (success=false, so /admin/errors
 *     lists it), carrying the shape — never Penny's text; and
 *  2. an email to the admin alert recipients, on production only, at most one
 *     an hour (the subject says how many happened in that hour).
 *
 * Production only for the reason `breakerCheck.alertsEnabled` gives: a preview
 * is a throwaway deployment, CI hits it on purpose, and the email cannot say
 * which deployment it came from.
 *
 * Never throws: the user already has their reply; an alert failing must not
 * turn it into a 500.
 */

export const PENNY_FALLBACK_PROVIDER = 'penny:fallback';
const THROTTLE_MS = 60 * 60 * 1000;

export function describeFallback(f: PennyFallback): string {
  return (
    `leakedMarkup=${f.leakedMarkup} leakRetries=${f.leakRetries} rawChars=${f.rawChars} ` +
    `chunks=${f.chunks} stop=${f.stopReason ?? 'unknown'}`
  );
}

/** Which of the two known causes the shape points at, in words, for the email. */
export function likelyCause(f: PennyFallback): string {
  if (f.leakedMarkup) {
    return 'Haiku wrote its tool call as TEXT (leaked markup) and the corrective retry did not recover it.';
  }
  if (f.rawChars === 0) return 'Haiku ended the turn with no text and no tool call (an empty reply).';
  return 'Haiku replied with text that sanitizing emptied, but it did not look like tool-call markup — a third case.';
}

function alertsEnabled(): boolean {
  return process.env.VERCEL_ENV === 'production';
}

export async function reportPennyFallback(input: {
  userId: string;
  tripId: string;
  fallback: PennyFallback;
  now?: Date;
}): Promise<void> {
  const shape = describeFallback(input.fallback);
  try {
    await logUsageEvent({
      userId: input.userId,
      tripId: input.tripId,
      provider: PENNY_FALLBACK_PROVIDER,
      requests: 0,
      success: false,
      errorMessage: `Penny replied "couldn't apply that cleanly": ${shape}`,
    });
  } catch (err) {
    console.error('[pennyFallbackAlert] usage row failed', err);
  }

  if (!alertsEnabled()) return;

  try {
    const now = input.now ?? new Date();
    // This occurrence's row is already written, so 1 means it is the first in the hour.
    const inLastHour = await countUsageEventsSince(
      PENNY_FALLBACK_PROVIDER,
      new Date(now.getTime() - THROTTLE_MS)
    );
    if (inLastHour > 1) return;

    const apiKey = process.env.AUTH_RESEND_KEY;
    const from = process.env.AUTH_EMAIL_FROM;
    if (!apiKey || !from) {
      console.error('[pennyFallbackAlert] Resend not configured; alert not sent', { shape });
      return;
    }
    const subject = `[PENNY] A user's turn fell back to "couldn't apply that cleanly"`;
    const lines = [
      'A Penny turn ended with no tool call, nothing applied and no text, so the user',
      'saw "Sorry, I couldn\'t apply that cleanly — could you rephrase and try again?".',
      '',
      `Likely cause: ${likelyCause(input.fallback)}`,
      `Shape:       ${shape}`,
      `User:        ${input.userId}`,
      `Trip:        ${input.tripId}`,
      '',
      'Every occurrence is a `penny:fallback` row on /admin/errors; this email is sent',
      'at most once an hour. The turn itself is in penny_turns for that trip.',
    ];
    const result = await new Resend(apiKey).emails.send({
      from,
      to: adminAlertRecipients(),
      subject,
      text: lines.join('\n'),
    });
    if (result.error) console.error('[pennyFallbackAlert] Resend error', result.error);
  } catch (err) {
    console.error('[pennyFallbackAlert] alert failed', err);
  }
}
