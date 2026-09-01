#!/usr/bin/env node
/**
 * Assert the PREVIEW environment is complete, right after `vercel pull`.
 *
 * WHY THIS EXISTS. Vercel scopes every variable to a set of environments, and
 * the picker defaults in a way that makes "Production" alone very easy to
 * choose. Nothing then tells you: the preview builds fine, deploys fine, and
 * the E2E suite goes red somewhere unrelated — a 500 from a route that wanted a
 * key, a sign-in button that 503s — and the failure reads as an app bug on the
 * PR you happen to be looking at. Two specs already hard-code their own version
 * of this check (`oauth-exchange` on AUTH_GOOGLE_IOS_CLIENT_ID,
 * `account-deletion` on DELETED_USER_ENC_KEY) precisely because that debugging
 * detour was worth paying a spec to avoid. This is that idea, for every
 * variable, one step earlier, before a browser has started.
 *
 * WHAT IT READS. `vercel pull --environment=preview` writes the resolved
 * preview environment to `.vercel/.env.preview.local`. That file IS the answer
 * — it is exactly what `vercel build` will compile against — so this checks the
 * artefact rather than re-asking the API and hoping the two agree.
 *
 * Usage:  node scripts/check-preview-env.mjs [--file <path>]
 * Exit 0 when complete; exit 1 listing what is missing and where to set it.
 */
import { readFileSync, existsSync } from 'node:fs';

/**
 * Variables the preview deployment must carry, and what breaks without each.
 *
 * The reason strings are the whole point: a missing-variable error that only
 * names the variable makes you go and find out why it matters, which is the
 * detour this file exists to delete.
 */
const REQUIRED = [
  ['ANTHROPIC_API_KEY', 'Penny and the three onboarding calls. Without it every planning turn 500s.'],
  ['AUTH_SECRET', 'Session signing. Nothing can sign in, so every authenticated spec dies at the door.'],
  ['AUTH_RESEND_KEY', 'Sends the OTP. login-otp.spec.ts reads a REAL delivered email back.'],
  ['AUTH_EMAIL_FROM', 'The From: address on that email.'],
  ['AUTH_GOOGLE_ID', 'Web Google sign-in — login-google-button.spec.ts.'],
  ['AUTH_GOOGLE_SECRET', 'Web Google sign-in.'],
  [
    'AUTH_GOOGLE_IOS_CLIENT_ID',
    'POST /api/mobile/oauth/exchange 503s without it, and every Google sign-in from the iOS app dies with nothing on the web side to notice it by. oauth-exchange.spec.ts fails rather than skips.',
  ],
  ['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', 'The one Maps key — browser JS and every server-side Google call.'],
  [
    'DELETED_USER_ENC_KEY',
    'Account deletion still completes without it (hash-only degraded mode) but the tombstone ciphertext is never written, and account-deletion.spec.ts asserts it decrypts.',
  ],
];

/**
 * Supplied by `vercel deploy -e ...` in ci.yml, NOT by the project env, and so
 * deliberately absent from the pulled file. Listed here so that a future reader
 * who notices they are missing does not "fix" it by adding them to the Vercel
 * project — DATABASE_URL especially, which must point at the PR's ephemeral
 * Neon branch and never at the project default.
 */
const SUPPLIED_AT_DEPLOY = ['DATABASE_URL', 'E2E_TEST_ENDPOINTS', 'E2E_TEST_ENDPOINTS_SECRET', 'PAYWALL_ENABLED', 'WEB_APP_ENABLED'];

/**
 * Nothing is forbidden on preview any more.
 *
 * `SUBSCRIPTION_TESTING` used to be, on the grounds that a preview is a public
 * URL serving a copy-on-write clone of production data. Both halves of that
 * changed: the preview database is being moved to empty-plus-migrations now
 * that `CANONICAL_TRIP` removes the need for prod rows, and the owner's point
 * stands that the switch exists precisely so automated tests can walk the
 * subscription states. The route it arms is still locked to the hardcoded
 * `sam+trial-<tag>@feraltravels.com` pattern and the admin generator behind it
 * still needs the cookie-only admin guard, the one-address allowlist, a
 * verified email and an `is_admin` row.
 */
const FORBIDDEN = [];

function parseEnvFile(text) {
  const found = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // An empty value is the same as absent for every variable above — each is
    // a key or a URL, and none has a meaningful empty form.
    if (value) found.add(key);
  }
  return found;
}

function main(argv) {
  const fileArg = argv.indexOf('--file');
  const file = fileArg !== -1 ? argv[fileArg + 1] : '.vercel/.env.preview.local';

  if (!existsSync(file)) {
    console.error(`✗ ${file} not found.`);
    console.error('  Run `vercel pull --yes --environment=preview` first — this checks what that produced.');
    return 1;
  }

  const present = parseEnvFile(readFileSync(file, 'utf8'));
  const missing = REQUIRED.filter(([k]) => !present.has(k));
  const leaked = FORBIDDEN.filter(([k]) => present.has(k));

  for (const k of SUPPLIED_AT_DEPLOY) {
    if (present.has(k)) {
      console.warn(`! ${k} is set on the Vercel PREVIEW environment and is also passed by ci.yml at deploy time.`);
      console.warn('  The deploy-time value wins, so this is not fatal — but the project value is dead weight');
      console.warn('  and reads like the source of truth. Remove it from Vercel unless you know why it is there.');
    }
  }

  if (leaked.length) {
    console.error('\n✗ Set on PREVIEW and must not be:');
    for (const [k, why] of leaked) console.error(`    ${k} — ${why}`);
  }

  if (missing.length) {
    console.error('\n✗ Missing from the Vercel PREVIEW environment:\n');
    for (const [k, why] of missing) console.error(`    ${k}\n        ${why}\n`);
    console.error('  Fix: Vercel → feral-travels → Settings → Environment Variables. Find each variable and');
    console.error('  tick Preview alongside Production (edit the existing row — do not add a second one).');
    console.error('  Then push again; `vercel pull` in the next run will see it.\n');
    console.error('  This is checked here rather than left to the E2E suite because a variable that is missing');
    console.error('  only on preview fails as an unrelated-looking app bug, on whichever PR happens to be open.');
  }

  if (missing.length || leaked.length) return 1;
  console.log(`✓ Preview environment complete — ${REQUIRED.length} required variables present.`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
