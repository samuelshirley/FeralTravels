/**
 * Pure helpers for fuel data-source (Overpass / OSRM) rate-limit monitoring.
 *
 * Kept dependency-free (no `server-only`, no DB) so the classification + throttle
 * logic is unit-testable in isolation. The server side (`dataSourceAlerts.ts`)
 * records events + sends the email; the admin dashboard (`dataSourceHealth.ts`)
 * reads them back. See docs/design/finn-fuel-agent.md.
 */

export type DataSource = 'overpass' | 'osrm';

/** Email at most this often per source-agnostic alert channel (first hit, then quiet). */
export const RATE_LIMIT_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Does this failure reason look like the data source throttling/overloading us?
 * Matches the HTTP codes the public Overpass/OSRM instances return when we're
 * over fair-use (429 rate limit; 503/504 overload/timeout) plus common wording.
 * Deliberately broad — a false positive just means one extra (throttled) email.
 */
export function isRateLimitSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (/\b(429|503|504)\b/.test(t)) return true;
  return (
    t.includes('too many requests') ||
    t.includes('rate limit') ||
    t.includes('rate-limit') ||
    t.includes('rate limited')
  );
}

/**
 * Throttle decision for the alert email: send if we've never sent, or the
 * cooldown has elapsed since the last send. Pure so the timing is testable.
 */
export function shouldSendAlert(
  lastSentEpochMs: number | null,
  nowEpochMs: number,
  cooldownMs: number = RATE_LIMIT_ALERT_COOLDOWN_MS
): boolean {
  if (lastSentEpochMs == null) return true;
  return nowEpochMs - lastSentEpochMs >= cooldownMs;
}
