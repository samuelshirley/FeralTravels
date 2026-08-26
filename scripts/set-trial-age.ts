/**
 * Age ONE account's `created_at` so its trial has already run out.
 *
 * Why this exists rather than a test endpoint: a TestFlight binary points at
 * PRODUCTION (`mobile/eas.json`), and `/api/test/*` is hard-off on production
 * with no override — deliberately, and that guard is not being weakened for
 * this. So walking the day-7 paywall on a real device means moving one row.
 *
 *   npx tsx scripts/set-trial-age.ts sam+trial7@feraltravels.com 7
 *   npx tsx scripts/set-trial-age.ts sam+trial7@feraltravels.com 7 --apply
 *
 * DRY RUN BY DEFAULT. Without `--apply` it prints what it would do and exits.
 *
 * It cannot create an account. Sign in first, through the real OTP flow, so
 * the row exists — there is no sign-in bypass anywhere in this codebase and
 * this is not going to be the first one.
 *
 * Reads DATABASE_URL from .env, which on this machine points at PROD. That is
 * the point, and it is also the danger: the guards below (single exact email,
 * one row, prints the row before and after, refuses more than one match)
 * are what keep "age a test user" from becoming "age everybody".
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/server/db/client';
import { users, subscriptions } from '../src/server/db/schema';
import { TRIAL_DAYS } from '../src/server/payments/constants';

async function main() {
  const [emailArg, daysArg, ...flags] = process.argv.slice(2);
  const apply = flags.includes('--apply');

  if (!emailArg) {
    console.error('usage: npx tsx scripts/set-trial-age.ts <email> [days=7] [--apply]');
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();
  const days = Number(daysArg ?? TRIAL_DAYS);
  if (!Number.isFinite(days) || days < 0 || days > 3650) {
    console.error(`Refusing an age of ${daysArg} days.`);
    process.exit(1);
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
      comped: users.comped,
      isAdmin: users.isAdmin,
    })
    .from(users)
    .where(eq(users.email, email));

  if (rows.length === 0) {
    console.error(`No user with email ${email}. Sign in on the device first, then re-run.`);
    process.exit(1);
  }
  if (rows.length > 1) {
    // `users.email` is unique, so this is impossible — which is exactly why it
    // is worth checking before an UPDATE runs against production.
    console.error(`${rows.length} rows matched ${email}. Refusing to touch any of them.`);
    process.exit(1);
  }

  const user = rows[0];
  const target = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(`user:        ${user.email} (${user.id})`);
  console.log(`created_at:  ${user.createdAt.toISOString()}`);
  console.log(`  ->         ${target.toISOString()}  (${days} days ago)`);

  if (user.comped) {
    console.log('');
    console.log('NOTE: this account is COMPED. Comped beats everything in the state');
    console.log('machine, so aging it changes nothing — it will still be entitled.');
    console.log('Use an address that is not on the comped allowlist.');
  }

  const [sub] = await db
    .select({ status: subscriptions.status, source: subscriptions.source })
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id))
    .limit(1);
  if (sub) {
    console.log('');
    console.log(`NOTE: this account has a subscription row (${sub.status}, ${sub.source}).`);
    console.log('The trial only decides anything when there is no subscription, so aging');
    console.log('will not produce a paywall until that row is gone or expired.');
  }

  if (!apply) {
    console.log('');
    console.log('DRY RUN — nothing was written. Re-run with --apply to do it.');
    process.exit(0);
  }

  await db.update(users).set({ createdAt: target }).where(eq(users.id, user.id));

  const [after] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  console.log('');
  console.log(`DONE. created_at is now ${after.createdAt.toISOString()}`);
  console.log('Reopen the app — Penny should be telling them the trial is up.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
