import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { Resend } from 'resend';
import { db } from '@/server/db/client';
import { trips, usageAlerts, users } from '@/server/db/schema';
import { MICROCENTS_PER_DOLLAR, STOP_MICROCENTS, WATCH_MICROCENTS } from './constants';

type Threshold = 'watch' | 'stop';

/**
 * Fire the threshold email at most ONCE per user per threshold.
 *
 * The claim row goes in first with `onConflictDoNothing`; a zero-row result
 * means somebody already sent it and we stop. Without that, the alert would
 * re-send on every blocked request and one capped user would mail support a
 * hundred times in an afternoon.
 *
 * Never throws. A failing mailer must not turn into a failed API request for
 * the user who happened to cross the line — they are already being told
 * something they did not want to hear.
 */
export async function maybeAlertThreshold(
  userId: string,
  microcents: number,
  crossed: { watch: boolean; stop: boolean }
): Promise<void> {
  try {
    const thresholds: Threshold[] = [];
    if (crossed.stop) thresholds.push('stop');
    if (crossed.watch) thresholds.push('watch');
    for (const threshold of thresholds) {
      const claimed = await db
        .insert(usageAlerts)
        .values({ userId, threshold, microcentsAtFiring: microcents })
        .onConflictDoNothing()
        .returning({ userId: usageAlerts.userId });
      if (claimed.length === 0) continue;
      await sendThresholdEmail(userId, threshold, microcents).catch((err) => {
        console.error('[payments/alerts] send failed', err);
      });
    }
  } catch (err) {
    console.error('[payments/alerts] bookkeeping failed', err);
  }
}

async function sendThresholdEmail(
  userId: string,
  threshold: Threshold,
  microcents: number
): Promise<void> {
  const apiKey = process.env.AUTH_RESEND_KEY;
  const from = process.env.AUTH_EMAIL_FROM;
  if (!apiKey || !from) {
    console.error('[payments/alerts] Resend not configured; alert not sent', { userId, threshold });
    return;
  }

  const [userRow] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [tripRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(trips)
    .where(eq(trips.userId, userId));

  const tripCount = Number(tripRow?.count ?? 0);
  const usd = microcents / MICROCENTS_PER_DOLLAR;
  const perTrip = tripCount > 0 ? usd / tripCount : usd;
  const limit =
    threshold === 'stop'
      ? STOP_MICROCENTS / MICROCENTS_PER_DOLLAR
      : WATCH_MICROCENTS / MICROCENTS_PER_DOLLAR;

  // Worded as an efficiency signal, deliberately. A cap firing is far more
  // likely to mean per-trip cost has regressed than that anyone is abusing
  // anything — $/trip is the number to read first, which is why it is last.
  const lines = [
    threshold === 'stop'
      ? `STOP threshold crossed ($${limit.toFixed(2)}/12mo) — this user is now soft-blocked.`
      : `WATCH threshold crossed ($${limit.toFixed(2)}/12mo) — nothing user-visible, no action needed.`,
    '',
    `User:            ${userRow?.email ?? userId}`,
    `12-month spend:  $${usd.toFixed(2)} (Anthropic only)`,
    `Trips:           ${tripCount}`,
    `Cost per trip:   $${perTrip.toFixed(2)}`,
    '',
    'Read $/trip before anything else. Real users have historically cost about',
    '$0.29 a trip; a figure well above that means per-trip cost regressed, not',
    'that this user did something wrong.',
  ];

  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from,
    to: 'support@feraltravels.com',
    subject: `[${threshold.toUpperCase()}] ${userRow?.email ?? userId} — $${usd.toFixed(2)}/12mo`,
    text: lines.join('\n'),
  });
  if (result.error) console.error('[payments/alerts] Resend error', result.error);
}

/** Has this user already been alerted for this threshold? Admin panel reads it. */
export async function alertAlreadyFired(userId: string, threshold: Threshold): Promise<boolean> {
  const rows = await db
    .select({ userId: usageAlerts.userId })
    .from(usageAlerts)
    .where(and(eq(usageAlerts.userId, userId), eq(usageAlerts.threshold, threshold)))
    .limit(1);
  return rows.length > 0;
}
