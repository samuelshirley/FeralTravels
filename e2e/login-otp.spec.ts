import { test, expect } from '@playwright/test';
import { submitOtpCode } from './fixtures/auth';
import {
  MAILBOX_CONFIGURED,
  SKIP_NO_MAILBOX,
  mailboxAddress,
  waitForMessage,
} from './fixtures/mailbox';

/**
 * The EMAIL half of sign-in — the one spec in the suite that touches a real
 * mailbox, and the only place the following is ever proven:
 *
 *   1. The app really sends: the live Resend API, with the deployment's own
 *      key and from-address, produces a message that lands in a mailbox we
 *      read back over HTTP rather than out of our own database.
 *   1b. And that the mail is DELIVERABLE, not merely delivered — SES's
 *      authentication verdicts (spf/dkim/dmarc) come back on the received
 *      message and are asserted below. See fixtures/mailbox.ts for what that
 *      does and doesn't cover.
 *   2. The delivered mail actually contains the code, in both parts: the
 *      subject line the phone shows on the lock screen, and a body a human
 *      could read it out of.
 *   3. That code — the one that arrived by mail, not the one read out of the
 *      database — signs the user in through the real six-box verify form.
 *
 * Everything else in the suite reads its OTP from /api/test/otp and never
 * sends anything (fixture addresses skip the transport). That is deliberate
 * and cheap; this spec is what stops it from being a blind spot. If the
 * template loses its code, the sending domain falls out of verification, or
 * the Resend key on the target deployment is wrong, THIS is the test that
 * goes red.
 *
 * It runs on every PR and costs one email each way.
 *
 * Skips only when the inbox isn't configured (a fresh checkout, an outside
 * contributor's fork). A WRONG credential fails loudly instead — see the
 * 401/404 handling in fixtures/mailbox.ts. E2E_MAX_SKIPPED in pipeline.yml is the
 * backstop: once E2E_INBOX_DOMAIN and the Resend key are set as repo secrets,
 * drop it to 0 so no spec may skip silently again.
 */
test.describe('Email OTP login — real delivery', () => {
  test.skip(!MAILBOX_CONFIGURED, SKIP_NO_MAILBOX);

  test('round-trip: a real emailed code signs a new user in', async ({ page }) => {
    // Real mail is the slow part: the Resend hand-off, the hop, and Resend's
    // own indexing of the received message. Generous, because a flake here
    // would teach people to ignore the one spec they shouldn't.
    test.setTimeout(150_000);

    const tag = `${(process.env.GITHUB_RUN_ID || `local${process.pid}`).toLowerCase()}-${Date.now().toString(36)}`;
    const email = mailboxAddress(tag);

    // --- 1. Ask for a code through the real form ---------------------------
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await Promise.all([
      page.waitForURL(/\/login\/verify/, { timeout: 15_000 }),
      page.getByRole('button', { name: /email me a code/i }).click(),
    ]);
    await expect(page.locator('text=/6-digit code/i')).toBeVisible();

    // --- 2. Wait for the mail to actually land -----------------------------
    const message = await waitForMessage(email, { timeoutMs: 90_000 });

    expect(message.to, 'delivered to the address we typed').toContain(email);

    // Deliverability, not just delivery. Resend sends via Amazon SES and
    // receives on SES inbound, so the message arrives stamped with SES's own
    // verdicts. These are what actually break in production — a DNS edit that
    // drops the SPF include, a DKIM key rotated without updating the record —
    // and they break SILENTLY: authentication failures get filed as spam
    // rather than bounced, so the first signal is a user who can't sign in.
    // If Resend ever stops surfacing this header, relax these three lines
    // deliberately; don't let them rot into a check of nothing.
    const auth = message.headers['authentication-results'] ?? '';
    expect(auth, 'no authentication-results header on the received message').not.toBe('');
    expect(auth, `SPF did not pass — ${auth}`).toContain('spf=pass');
    expect(auth, `DMARC did not pass — ${auth}`).toContain('dmarc=pass');

    // The subject is what shows on a lock screen, so the code has to be in it.
    // It is also where the spec takes the code FROM: the HTML body renders it
    // as "123 456" for readability, and a bare \d{6} against that body finds a
    // hex colour (#333333) long before it finds the code.
    const subjectMatch = message.subject.match(/\b(\d{6})\b/);
    expect(
      subjectMatch,
      `no 6-digit code in the delivered subject line: "${message.subject}"`,
    ).not.toBeNull();
    const code = subjectMatch![1];

    // Both body parts must carry it too — an email whose code only exists in
    // the subject is one Gmail's preview pane renders useless.
    expect(message.text, 'plain-text part carries the code').toContain(code);
    const displayed = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(
      message.html,
      `HTML part shows the code as "${displayed}" (renderOtpEmail splits it for readability)`,
    ).toContain(displayed);

    // --- 3. Sign in with the code that arrived by mail ---------------------
    // Shared with the cheap path on purpose: entering the code is the same UI
    // dance either way, and the hydration race it works around bit both.
    await submitOtpCode(page, code, /\/trips(\?|$)/);

    await expect(page).toHaveURL(/\/trips/);
    await expect(page.locator('h1')).toHaveText(/Trips/i);
  });
});
