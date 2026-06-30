import 'server-only';
import { eq } from 'drizzle-orm';
import { Resend } from 'resend';
import { db } from '@/server/db/client';
import { appMeta } from '@/server/db/schema';
import { logUsageEvent } from '@/server/repos/usage';
import { adminAlertRecipients } from '@/server/auth/admin';
import {
  shouldSendAlert,
  type DataSource,
} from '@/lib/dataSourceRateLimit';

/**
 * Records fuel data-source (Overpass / OSRM) rate-limit events and emails the
 * admin when we start getting throttled — the early warning that it's time to
 * self-host the OSM/OSRM backends. See docs/design/finn-fuel-agent.md.
 *
 * Events go to `usage_events` (provider `datasource:<source>:rate-limit`,
 * success=false) so the admin dashboard (`dataSourceHealth.ts`) can read them.
 * The email is throttled (first hit, then quiet for ~1h) via an `app_meta`
 * cooldown key so a throttling burst can't flood the inbox.
 *
 * Nothing here throws — a monitoring failure must never break fuel planning.
 */

const ALERT_LAST_SENT_KEY = 'datasource_ratelimit_alert_last_sent';

function rateLimitProvider(source: DataSource): string {
  return `datasource:${source}:rate-limit`;
}

async function getMeta(key: string): Promise<string | null> {
  const rows = await db.select({ value: appMeta.value }).from(appMeta).where(eq(appMeta.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

async function setMeta(key: string, value: string): Promise<void> {
  await db
    .insert(appMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: appMeta.key, set: { value } });
}

/**
 * Record a rate-limit hit and (throttled) email the admin. Call from the data
 * source's failure path. Fire-and-forget — callers should not await-block on it.
 */
export async function reportRateLimit(source: DataSource, detail: string): Promise<void> {
  // 1. Always record the event so the dashboard reflects it.
  await logUsageEvent({
    provider: rateLimitProvider(source),
    success: false,
    errorMessage: detail.slice(0, 500),
  }).catch((e) => console.error('[datasource] failed to record rate-limit event:', e));

  // 2. Throttled email alert.
  try {
    await maybeSendRateLimitEmail(source, detail);
  } catch (e) {
    console.error('[datasource] rate-limit email failed (continuing):', e);
  }
}

async function maybeSendRateLimitEmail(source: DataSource, detail: string): Promise<void> {
  const lastRaw = await getMeta(ALERT_LAST_SENT_KEY);
  const lastMs = lastRaw ? Number(lastRaw) : null;
  if (!shouldSendAlert(Number.isFinite(lastMs) ? lastMs : null, Date.now())) return;

  const apiKey = process.env.AUTH_RESEND_KEY;
  const from = process.env.AUTH_EMAIL_FROM;
  const recipients = adminAlertRecipients();
  if (!apiKey || !from || recipients.length === 0) {
    // Not configured — record the attempt so it's visible, but don't fail.
    console.warn('[datasource] rate-limit alert email skipped (Resend / recipients not configured)');
    return;
  }

  const label = source === 'overpass' ? 'OSM Overpass (station search)' : 'OSRM (route geometry)';
  const subject = `⚠️ Feral Travels: ${label} is rate-limiting us`;
  const body =
    `Finn's ${label} data source returned a rate-limit / overload response.\n\n` +
    `Detail: ${detail}\n\n` +
    `This is the signal to move off the public instance — point ${
      source === 'overpass' ? 'OVERPASS_ENDPOINT' : 'OSRM_ENDPOINT'
    } at a self-hosted or paid instance.\n\n` +
    `Further alerts are suppressed for ~1 hour. See /admin/data-sources for the full picture.`;

  const resend = new Resend(apiKey);
  const result = await resend.emails.send({
    from,
    to: recipients,
    subject,
    text: body,
  });
  if (result.error) {
    console.error('[datasource] Resend send failed:', result.error);
    return; // don't stamp cooldown if the send failed — allow a retry next hit
  }
  await setMeta(ALERT_LAST_SENT_KEY, String(Date.now()));
}
