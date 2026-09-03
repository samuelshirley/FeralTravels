#!/usr/bin/env node
/**
 * Turn paywall enforcement on or off by writing the `app_meta` row directly.
 *
 *   node scripts/set-paywall-flag.mjs on
 *   node scripts/set-paywall-flag.mjs off
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The switch used to be `PAYWALL_ENABLED=1` in the environment, and CI set it
 * on the tested preview with `vercel deploy -e PAYWALL_ENABLED="1"`. It had to
 * be ON there: `e2e/subscriptions.spec.ts` ages an account, plants spend and
 * writes a subscription row, then asserts the wall appears — and with the
 * switch off `applySwitch` hands every one of them full access.
 *
 * On 2026-09-02 the switch moved into `app_meta.paywall_enabled`, so that
 * turning it OFF stops needing a redeploy. That change silently disarmed the
 * CI flag: the `-e PAYWALL_ENABLED="1"` was still there and nothing read it any
 * more. Six enforcement specs failed and the specs asserting the ABSENCE of a
 * wall passed for no reason at all — which is the worse half, because they
 * would keep passing with the paywall completely broken. The comment in
 * `ci.yml` had already described that exact failure from the first time it
 * happened; the fix then was the env var, and this is the fix now.
 *
 * ── Why a database write and not a test-only env override ──────────────────
 *
 * An override would have been a smaller diff and would have made CI green just
 * as fast. It would also mean the suite exercised a code path production does
 * not use, and would put back the second source of truth that moving the switch
 * into the database removed. The e2e suite exists to test what ships; the thing
 * that ships reads a row, so CI writes a row.
 *
 * Nothing here needs to care about the 30-second read cache in `switch.ts`:
 * this runs BEFORE the deployment exists, so the first read any instance makes
 * already sees the new value.
 *
 * Safe to point at any database, including production — it writes one boolean
 * and prints what it did. The admin UI (`POST /api/admin/paywall`) is the
 * normal way to flip it, and records who pressed it; this does not, which is
 * why it is a CI tool and not an ops one.
 */
import 'dotenv/config';
import postgres from 'postgres';

const arg = process.argv[2];
if (arg !== 'on' && arg !== 'off') {
  console.error('usage: node scripts/set-paywall-flag.mjs on|off');
  process.exit(2);
}
const value = arg === 'on' ? '1' : '0';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('set-paywall-flag: DATABASE_URL is not set.');
  process.exit(1);
}

// `require: true` matches every other script that talks to Neon. A local
// throwaway cluster has no TLS, so fall back rather than refuse to run there —
// this is used against both.
const sql = postgres(url, { ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : 'require', max: 1 });

try {
  await sql`
    insert into app_meta (key, value) values ('paywall_enabled', ${value})
    on conflict (key) do update set value = excluded.value
  `;
  const [row] = await sql`select value from app_meta where key = 'paywall_enabled'`;
  // Read back rather than trust the write: this is the one line of output a CI
  // log will carry, and "I asked for on" is a weaker claim than "it is on".
  console.log(`paywall_enabled = ${row?.value ?? '<missing>'} (enforcement ${row?.value === '1' ? 'ON' : 'OFF'})`);
} catch (err) {
  console.error('set-paywall-flag: failed —', err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await sql.end();
}
