/**
 * Verify the e2e test mailbox is reachable BEFORE the suite runs.
 * Run with: npx tsx scripts/preflight-mailbox.ts
 *
 * The MailSlurp preflight this replaces checked the wrong thing. It called
 * /user/info, got HTTP 200 and passed — while inbox creation was refused
 * because the free trial had expired. Authentication succeeding said nothing
 * about whether the capability worked.
 *
 * So this tests the capability: log in to the mailbox and open the folder the
 * suite reads. If that works, the suite can read OTP mail.
 */
import {
  verifyMailboxAccess,
  IMAP_USER,
  IMAP_HOST,
  IMAP_MAILBOX,
  MAILBOX_CONFIGURED,
} from '../e2e/fixtures/mailbox';

async function main(): Promise<void> {
  if (!MAILBOX_CONFIGURED) {
    console.error(
      '::error::E2E_IMAP_USER / E2E_IMAP_PASSWORD are not set. Settings → Secrets and variables → Actions. E2E_IMAP_PASSWORD must be a Google APP PASSWORD, not the account password.'
    );
    process.exit(1);
  }

  try {
    const { mailbox, exists } = await verifyMailboxAccess();
    console.log(`Mailbox OK — ${IMAP_USER} @ ${IMAP_HOST}, folder "${mailbox}" (${exists} messages)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `::error::Cannot reach the e2e mailbox (${IMAP_USER} @ ${IMAP_HOST}, folder "${IMAP_MAILBOX}"): ${msg}`
    );
    console.error(
      'AUTHENTICATIONFAILED usually means E2E_IMAP_PASSWORD is the account password rather than an app password, or 2-Step Verification is off so app passwords are unavailable. NONEXISTENT means the folder name is wrong — try E2E_IMAP_MAILBOX="[Gmail]/All Mail".'
    );
    process.exit(1);
  }
}

void main();
