import { ImapFlow } from 'imapflow';

/**
 * Test mailbox — reads OTP emails over IMAP from a mailbox you own.
 *
 * Replaces MailSlurp (2026-08-14). MailSlurp's free trial expired 30 days
 * after signup and their own error says trials aren't available again after
 * expiry, so the whole suite was silently skipping. The dependency was never
 * worth it: all the suite needs is a unique address per test and the code
 * that lands in it.
 *
 * The trick that removes the need for a disposable-inbox service is
 * PLUS-ADDRESSING. `sam+playwright-abc123@feraltravels.com` is delivered to
 * `sam@feraltravels.com`, but the app treats it as a different user —
 * `server/auth/otp.ts` normalises with `email.trim().toLowerCase()` and
 * nothing strips the +tag, so each test still gets a genuinely fresh account.
 * One real mailbox becomes unlimited unique addresses, free, with nobody able
 * to expire it.
 *
 * Setup (Google Workspace / Gmail):
 *   1. 2-Step Verification on the account (required for app passwords).
 *   2. Create an app password, use it as E2E_IMAP_PASSWORD — NOT the real one.
 *   3. E2E_IMAP_USER is the full address, e.g. sam@feraltravels.com.
 *
 * If a Gmail filter archives or labels the test mail it won't be in INBOX;
 * point E2E_IMAP_MAILBOX at '[Gmail]/All Mail' in that case.
 */

export const IMAP_USER = process.env.E2E_IMAP_USER?.trim();
export const IMAP_PASSWORD = process.env.E2E_IMAP_PASSWORD?.trim();
export const IMAP_HOST = process.env.E2E_IMAP_HOST?.trim() || 'imap.gmail.com';
export const IMAP_PORT = Number(process.env.E2E_IMAP_PORT) || 993;
export const IMAP_MAILBOX = process.env.E2E_IMAP_MAILBOX?.trim() || 'INBOX';

/** Trash folder for read test mail. Gmail's is '[Gmail]/Trash'. */
export const IMAP_TRASH = process.env.E2E_IMAP_TRASH?.trim() || '[Gmail]/Trash';

/** Set E2E_MAILBOX_KEEP=1 to leave test mail in place (debugging). */
const KEEP_MAIL = process.env.E2E_MAILBOX_KEEP === '1';

export const MAILBOX_CONFIGURED = Boolean(IMAP_USER && IMAP_PASSWORD);

export const SKIP_NO_MAILBOX =
  'E2E_IMAP_USER / E2E_IMAP_PASSWORD not set — real-OTP sign-in unavailable, spec skipped';

/**
 * Build a unique plus-addressed variant of the test mailbox.
 * `sam@feraltravels.com` + "abc123" → `sam+playwright-abc123@feraltravels.com`
 */
export function taggedAddress(tag: string): string {
  if (!IMAP_USER) throw new Error(SKIP_NO_MAILBOX);
  const at = IMAP_USER.lastIndexOf('@');
  const local = IMAP_USER.slice(0, at);
  const domain = IMAP_USER.slice(at + 1);
  // Strip any +tag already on the configured address so tags never nest.
  const base = local.split('+')[0];
  return `${base}+playwright-${tag}@${domain}`.toLowerCase();
}

function connect(): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER!, pass: IMAP_PASSWORD! },
    logger: false,
    // The suite opens a short-lived connection per wait; don't let a hung
    // socket eat the whole per-test timeout.
    socketTimeout: 30_000,
  });
}

/** Verify the credentials work at all. Used by the CI preflight. */
export async function verifyMailboxAccess(): Promise<{ mailbox: string; exists: number }> {
  const client = connect();
  await client.connect();
  try {
    const box = await client.mailboxOpen(IMAP_MAILBOX, { readOnly: true });
    return { mailbox: IMAP_MAILBOX, exists: box.exists };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * The 6-digit code, from the SUBJECT first.
 *
 * Subject is `"123456 is your Feral Travels sign-in code"`. The HTML body is a
 * trap: inline CSS hex colours (#333333) match a bare \d{6} before the real
 * code does, and the displayed code is split "123 456". The body fallback
 * targets the hidden origin-bound "#<code>" line (WICG one-time-code format).
 */
export function extractOtpCode(subject?: string, body?: string): string | null {
  const match = (subject || '').match(/\b(\d{6})\b/) || (body || '').match(/#(\d{6})\b/);
  return match ? match[1] : null;
}

function addressedTo(envelopeTo: Array<{ address?: string }> | undefined, wanted: string): boolean {
  return (envelopeTo || []).some((a) => (a.address || '').toLowerCase() === wanted);
}

/**
 * Poll the mailbox until an OTP email addressed to `to` arrives, and return
 * its code. Read mail is moved to Trash (recoverable) so CI runs don't pile up
 * in a real inbox — set E2E_MAILBOX_KEEP=1 to leave it.
 */
export async function waitForOtpCode(
  to: string,
  opts: { timeoutMs?: number; since?: Date } = {}
): Promise<string> {
  const wanted = to.toLowerCase();
  const timeoutMs = opts.timeoutMs ?? 90_000;
  // Bound the IMAP search so we never walk the whole mailbox.
  const since = opts.since ?? new Date(Date.now() - 10 * 60_000);
  const deadline = Date.now() + timeoutMs;

  let lastError = '';
  while (Date.now() < deadline) {
    const client = connect();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(IMAP_MAILBOX);
      try {
        const uids = await client.search({ since }, { uid: true });
        // imapflow returns false (not []) when nothing matches.
        for (const uid of Array.isArray(uids) ? uids.slice().reverse() : []) {
          const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
          if (!msg || !addressedTo(msg.envelope?.to, wanted)) continue;

          let code = extractOtpCode(msg.envelope?.subject);
          if (!code) {
            // fetchOne returns `false | FetchMessageObject`, and `?.` does not
            // narrow away the `false` — check it explicitly.
            const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
            const source = full ? full.source?.toString('utf8') : undefined;
            code = extractOtpCode(msg.envelope?.subject, source);
          }
          if (!code) continue;

          if (!KEEP_MAIL) {
            await client.messageMove(String(uid), IMAP_TRASH, { uid: true }).catch(() => {});
          }
          return code;
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      await client.logout().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  throw new Error(
    `[e2e/mailbox] No OTP email for ${to} within ${timeoutMs}ms` +
      (lastError ? ` (last IMAP error: ${lastError})` : '') +
      `. Check the app actually sent (AUTH_RESEND_KEY on the target) and that no mail filter` +
      ` moved it out of ${IMAP_MAILBOX} — set E2E_IMAP_MAILBOX='[Gmail]/All Mail' if so.`
  );
}
