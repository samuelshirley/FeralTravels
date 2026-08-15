/**
 * The real inbox — the one place the suite touches actual email.
 *
 * WHY THIS EXISTS: every other spec reads its OTP from `/api/test/otp` (see
 * fixtures/auth.ts), and fixture addresses skip the Resend transport entirely.
 * That is the right trade for eleven specs that need a signed-in user and do
 * not care about mail — but on its own it means NOTHING in the suite proves
 * the app can deliver a sign-in email. `login-otp.spec.ts` is that proof, and
 * this module is how it gets it: a real address, on a real receiving domain,
 * whose contents come back over an API rather than out of our own database.
 *
 * WHY RESEND INBOUND: we already send through Resend and already have the key,
 * so this adds no vendor, no account to get banned, and no bill. Addresses on
 * a Resend-managed receiving domain (`<anything>@<id>.resend.app`) need no DNS
 * at all, and a custom subdomain needs one MX record. Inbound messages count
 * against the same quota as outbound — this spec spends 2 of 3,000/month.
 *
 * WHAT THIS PROVES — more than expected, and verified against the live API
 * before this was written (2026-08-15). The worry was that mail Resend both
 * sends and receives might never leave their network, making a pass here
 * worthless as evidence about real deliverability. It doesn't work that way:
 * Resend sends via Amazon SES and receives on SES inbound, so the message
 * makes a real SMTP hop and arrives carrying SES's own verdict headers. A
 * probe came back with `spf=pass`, `dkim=pass header.i=@feraltravels.com` and
 * `dmarc=pass header.from=feraltravels.com`, plus a full Received chain.
 *
 * The spec asserts those verdicts, which turns this from a smoke test into a
 * genuine deliverability check: if the sending domain's SPF include is dropped
 * or a DKIM key is rotated without updating DNS, this goes red — BEFORE users
 * find out by having sign-in mail filed as spam. That failure mode is silent
 * in production (authentication failures get filtered, not bounced), so an
 * early warning is worth a lot.
 *
 * The residual gap is narrow: passing here is not proof that a specific
 * consumer mailbox accepts the mail, since Gmail and iCloud also weigh sender
 * reputation, which no test can assert. It IS proof that the mail is properly
 * authenticated and well-formed, which is the part we control.
 *
 * WHY NO SDK: `resend` is already a dependency, but its receiving helpers are
 * newer than the pinned v4 and the whole integration is two documented GET
 * endpoints. Nothing to install, nothing to keep in step.
 */

const API_BASE = 'https://api.resend.com';

/**
 * The runner's own key. Falls back to AUTH_RESEND_KEY so there is exactly one
 * Resend credential in this project rather than a second one to keep in sync —
 * it is the same account either way, and the same key the app sends with.
 */
export const RESEND_KEY =
  process.env.RESEND_API_KEY?.trim() || process.env.AUTH_RESEND_KEY?.trim() || '';

/**
 * The receiving domain configured in Resend → Receiving. Either the managed
 * one (`<id>.resend.app`, zero DNS) or a subdomain we point an MX record at
 * (`inbox.feraltravels.com`). Deliberately NOT `e2e.feraltravels.com`: that
 * one has no MX on purpose and is the fixture pattern the OTP-read endpoint
 * is fenced by.
 */
export const INBOX_DOMAIN = process.env.E2E_INBOX_DOMAIN?.trim() || '';

/** Both halves or nothing — a key without a receiving domain can't address anything. */
export const MAILBOX_CONFIGURED = Boolean(RESEND_KEY && INBOX_DOMAIN);

export const SKIP_NO_MAILBOX =
  'E2E_INBOX_DOMAIN and a Resend key (RESEND_API_KEY or AUTH_RESEND_KEY) not both set — no real ' +
  'inbox, so real delivery cannot be proven. Configure a receiving domain in Resend → Receiving ' +
  'and set both (repo secrets in CI, .env locally) to run this spec.';

/**
 * A fresh, never-before-used address. Nothing is provisioned: any local part
 * on the receiving domain is accepted, which is what makes per-test isolation
 * free here. Metering inbox *creation* is precisely what made the previous
 * vendor unusable at this shape of usage.
 */
export function mailboxAddress(tag: string): string {
  return `playwright-${tag}@${INBOX_DOMAIN}`;
}

export interface DeliveredMessage {
  id: string;
  subject: string;
  html: string;
  text: string;
  to: string[];
  /** Lower-cased header names → values. Carries SES's spf/dkim/dmarc verdicts. */
  headers: Record<string, string>;
}

/** Header names arrive lower-cased today; normalize so a lookup can't miss. */
function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k.toLowerCase(),
      typeof v === 'string' ? v : String(v ?? ''),
    ]),
  );
}

/** Recipients come back as strings or objects depending on the endpoint; flatten both. */
function normalizeTo(value: unknown): string[] {
  const one = (v: unknown): string =>
    typeof v === 'string'
      ? v
      : typeof (v as { email?: string })?.email === 'string'
        ? ((v as { email: string }).email)
        : '';
  const list = Array.isArray(value) ? value : [value];
  return list.map(one).filter(Boolean).map((s) => s.toLowerCase());
}

async function call(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // A bad key or an account without receiving enabled must go RED, not skip:
    // a spec that skips itself when its credential is wrong is how a suite
    // ends up green while proving nothing.
    throw new Error(
      `[e2e/mailbox] Resend GET ${path} → ${res.status} ${res.statusText}` +
        `${body ? `: ${body.slice(0, 400)}` : ''}` +
        (res.status === 401 ? ' (check RESEND_API_KEY / AUTH_RESEND_KEY)' : '') +
        (res.status === 404
          ? ' (inbound receiving may not be enabled on this Resend account)'
          : ''),
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Poll the received-emails list until one addressed to `sentTo` appears, then
 * fetch it in full.
 *
 * Two calls, and a client-side filter, because the list endpoint returns
 * metadata only and has no recipient filter. Fine at this size — the suite
 * sends one of these per run — but it is the reason this is a poll rather than
 * a query, and the reason to revisit if the inbox ever gets busy.
 */
export async function waitForMessage(
  sentTo: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<DeliveredMessage> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const target = sentTo.toLowerCase();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const page = await call('/emails/receiving?limit=100');
    const items = (page.data ?? page.items ?? []) as Array<Record<string, unknown>>;
    const hit = Array.isArray(items)
      ? items.find((m) => normalizeTo(m.to).includes(target))
      : undefined;

    if (hit) {
      const id = String(hit.id ?? hit.email_id ?? '');
      const full = await call(`/emails/receiving/${encodeURIComponent(id)}`);
      return {
        id,
        subject: String(full.subject ?? hit.subject ?? ''),
        html: String(full.html ?? ''),
        text: String(full.text ?? ''),
        to: normalizeTo(full.to ?? hit.to),
        headers: normalizeHeaders(full.headers),
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(
    `[e2e/mailbox] Nothing arrived at ${sentTo} within ${Math.round(timeoutMs / 1000)}s. ` +
      `The app accepted the /login submit, so the code was generated and stored — what failed is ` +
      `delivery. Check AUTH_RESEND_KEY and AUTH_EMAIL_FROM on the target deployment, that ` +
      `E2E_INBOX_DOMAIN (${INBOX_DOMAIN || 'unset'}) matches a domain listed under Resend → ` +
      `Receiving, and the Resend dashboard for a bounce or a daily-quota rejection.`,
  );
}
