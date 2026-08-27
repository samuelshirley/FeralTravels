#!/usr/bin/env node
/**
 * Mint the account the iOS Maestro flows sign in as, against a deployed app.
 *
 * Prints `EMAIL=…` and `CODE=…` on stdout (and appends them to $GITHUB_OUTPUT
 * when CI sets it). Everything else goes to stderr, so the caller can eval the
 * stdout safely.
 *
 * WHY THIS EXISTS AT ALL: the flows must not depend on a mailbox. This suite
 * has been switched off by a third-party inbox twice already — MailSlurp's
 * trial expired and a Workspace IMAP account never authenticated — and the
 * lesson recorded in CLAUDE.md is that a pipeline should not rest on a vendor
 * who can turn it off. So the code is read back from the app's own guarded
 * endpoint, exactly as `e2e/fixtures/auth.ts` does it for Playwright.
 *
 * NOTHING IS BYPASSED, and the distinction matters:
 *   - `sendOtpCode` really runs. The code is stored with its real expiry.
 *   - The app types it into the real six-box form and the real `verifyOtpCode`
 *     checks it, with its real attempt limits.
 *   - `/api/test/otp` replaces the INBOX, not a step of authentication. It is
 *     404 unless `E2E_TEST_ENDPOINTS=1` (never true on production, no override
 *     env is honoured), it wants the per-run secret, and it refuses any address
 *     outside `FIXTURE_EMAIL_PATTERN`.
 *
 * The address shape is `playwright-<runid>-<n>@e2e.feraltravels.com`. That
 * subdomain has no MX record, so an address this script can use is one no
 * person can ever receive mail at.
 */

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return fallback;
}

const baseUrl = (arg('base-url', process.env.E2E_BASE_URL) || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('usage: node scripts/ios-e2e-fixture.mjs --base-url https://<preview>');
  process.exit(2);
}

const secret = (process.env.E2E_TEST_ENDPOINTS_SECRET || '').trim();
const bypass = (process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();

/** Same headers `e2e/fixtures/constants.ts` sends, for the same reasons. */
function testHeaders() {
  const h = { 'content-type': 'application/json' };
  if (secret) h['x-e2e-test-secret'] = secret;
  if (bypass) h['x-vercel-protection-bypass'] = bypass;
  return h;
}

/**
 * Unique per run AND per invocation. A reused address is an AGED account
 * carrying the last run's trips and session — which is a different test from
 * the one this claims to be. Same argument as `uniqueEmail()` in the Playwright
 * fixtures and as the `sam+trial-<tag>` pattern in `payments/testPurchase.ts`.
 */
function uniqueEmail() {
  const runId = (process.env.GITHUB_RUN_ID || `local${process.pid}`).toLowerCase();
  return `playwright-${runId}-ios-${Date.now().toString(36)}@e2e.feraltravels.com`;
}

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: testHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function main() {
  const email = uniqueEmail();

  // The canonical graph — a vehicle and a named trip — because the flows assert
  // on 'E2E Fixture Trip' to prove the session really resolved this user's own
  // data. Names come from e2e/fixtures/constants.ts; keep them in step.
  const seeded = await post('/api/test/seed', {
    email,
    userName: 'E2E Fixture User',
    vehicleName: 'E2E Fixture Van',
    tripName: 'E2E Fixture Trip',
  });
  if (!seeded.ok) {
    throw new Error(
      `seed failed (${seeded.status}): ${seeded.text}\n` +
        `404 here means E2E_TEST_ENDPOINTS=1 is missing on the target, or ` +
        `x-e2e-test-secret does not match E2E_TEST_ENDPOINTS_SECRET.`
    );
  }

  // The app's OWN send endpoint, not the web one — this is the route the
  // Expo sign-in screen calls, so a break in it fails here rather than
  // mysteriously inside a simulator.
  const sent = await post('/api/mobile/otp/send', { email });
  if (!sent.ok) throw new Error(`otp send failed (${sent.status}): ${sent.text}`);

  // Poll: the send resolving does not guarantee the row has landed.
  const deadline = Date.now() + 20_000;
  let last = '';
  while (Date.now() < deadline) {
    const res = await post('/api/test/otp', { email });
    if (res.ok) {
      const body = JSON.parse(res.text || '{}');
      if (body.code) {
        emit(email, body.code);
        return;
      }
      last = 'code not written yet';
    } else {
      last = `${res.status}: ${res.text}`;
      if (res.status === 404) break; // endpoint off or wrong secret — polling cannot help
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no OTP for ${email} (${last})`);
}

function emit(email, code) {
  process.stderr.write(`[ios-e2e] fixture ready: ${email}\n`);
  process.stdout.write(`EMAIL=${email}\nCODE=${code}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `email=${email}\ncode=${code}\n`);
  }
}

main().catch((err) => {
  console.error(`[ios-e2e] ${err.message}`);
  process.exit(1);
});
