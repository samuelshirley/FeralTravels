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
  passwordShape,
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

  // Shape, never the value. A Google app password is 16 characters; anything
  // else is the diagnosis before we even connect.
  console.log(`E2E_IMAP_USER: ${IMAP_USER}`);
  console.log(`E2E_IMAP_PASSWORD: ${passwordShape()}`);

  try {
    const { mailbox, exists } = await verifyMailboxAccess();
    console.log(`Mailbox OK — ${IMAP_USER} @ ${IMAP_HOST}, folder "${mailbox}" (${exists} messages)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `::error::Cannot reach the e2e mailbox (${IMAP_USER} @ ${IMAP_HOST}, folder "${IMAP_MAILBOX}"): ${msg}`
    );
    console.error('Most likely causes, in order:');
    console.error(
      '  1. E2E_IMAP_PASSWORD is the ACCOUNT password, not an app password. Google Account → Security → 2-Step Verification → App passwords.'
    );
    console.error(
      '  2. IMAP is off for this mailbox. Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP. For Workspace also check Admin console → Apps → Google Workspace → Gmail → End User Access → IMAP.'
    );
    console.error(
      '  3. Workspace policy blocks app passwords (2-Step Verification not enforced, or "Less secure app access" locked down by the admin).'
    );
    console.error(
      '  4. NONEXISTENT means the folder is wrong, not the credentials — set the E2E_IMAP_MAILBOX repo variable to "[Gmail]/All Mail".'
    );
    process.exit(1);
  }
}

void main();
