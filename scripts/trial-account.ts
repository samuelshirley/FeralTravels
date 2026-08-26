/**
 * Test accounts for the paywall, against whatever DATABASE_URL points at.
 *
 *   npx tsx scripts/trial-account.ts new
 *   npx tsx scripts/trial-account.ts age  sam+trial-260826a@feraltravels.com 7 --apply
 *   npx tsx scripts/trial-account.ts reset sam+trial-260826a@feraltravels.com --apply
 *
 * WHY A FRESH ADDRESS PER RUN, and why `new` exists at all: reusing one
 * address does not test a trial, it tests an aged account. By the second run it
 * is carrying the first run's trips, usage rows and — the one that actually
 * breaks the test — a subscription row, at which point `created_at` decides
 * nothing at all and the paywall will never appear no matter how far back you
 * push it. `reset` exists for when you want the same address anyway; it is the
 * more fragile path and it says what it does not clear.
 *
 * `new` only PRINTS an address. It cannot create the account: there is no
 * sign-in bypass anywhere in this codebase and this is not going to be the
 * first. Sign in with it on the device through the real OTP flow, then age it.
 *
 * DRY RUN BY DEFAULT. Without `--apply`, `age` and `reset` print what they
 * would do and exit having written nothing.
 *
 * This reads DATABASE_URL from .env, which on the author's machine points at
 * PROD. That is the point of the script and also its danger, which is what the
 * guards are for: one exact email match or nothing, a hard refusal on any
 * address outside the test pattern unless `--force`, and the row printed before
 * and after.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../src/server/db/client';
import { users, subscriptions, usageAlerts } from '../src/server/db/schema';
import { TRIAL_DAYS } from '../src/server/payments/constants';

/**
 * Must match TEST_PURCHASE_EMAIL_PATTERN in src/server/payments/testPurchase.ts.
 * Restated rather than imported because that module is `server-only` and this
 * is a plain node script — the test there is the thing that actually gates
 * purchases, so a drift between the two costs a confusing afternoon, not a
 * security hole.
 */
const TEST_PATTERN = /^sam\+trial-[a-z0-9-]{1,40}@feraltravels\.com$/i;

function usage(): never {
  console.error('usage:');
  console.error('  npx tsx scripts/trial-account.ts new');
  console.error('  npx tsx scripts/trial-account.ts age <email> [days] [--apply] [--force]');
  console.error('  npx tsx scripts/trial-account.ts reset <email> [--apply] [--force]');
  process.exit(1);
}

async function loadUser(email: string, force: boolean) {
  if (!TEST_PATTERN.test(email) && !force) {
    console.error(`${email} is not a test address (sam+trial-<tag>@feraltravels.com).`);
    console.error('Pass --force if you really mean to touch a real account.');
    process.exit(1);
  }
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
      comped: users.comped,
    })
    .from(users)
    .where(eq(users.email, email));

  if (rows.length === 0) {
    console.error(`No user with email ${email}. Sign in on the device first, then re-run.`);
    process.exit(1);
  }
  if (rows.length > 1) {
    // `users.email` is unique, so this cannot happen — which is exactly why it
    // is worth checking before an UPDATE runs against production.
    console.error(`${rows.length} rows matched ${email}. Refusing to touch any of them.`);
    process.exit(1);
  }
  const user = rows[0];
  if (user.comped) {
    console.log('');
    console.log('NOTE: this account is COMPED, and comped beats every other state.');
    console.log('Nothing you do here will produce a paywall on it.');
  }
  return user;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = rest.filter((a) => a.startsWith('--'));
  const args = rest.filter((a) => !a.startsWith('--'));
  const apply = flags.includes('--apply');
  const force = flags.includes('--force');

  if (cmd === 'new') {
    // Short, lowercase, collision-proof enough for a human running this a few
    // times a week. Deliberately not a timestamp alone — two runs in the same
    // minute would collide and silently reuse an account.
    const tag = `${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;
    const email = `sam+trial-${tag}@feraltravels.com`;
    console.log(email);
    console.log('');
    console.log('1. Sign in with this on the device, through the real OTP flow.');
    console.log('   The code lands in the sam@feraltravels.com inbox.');
    console.log(`2. npx tsx scripts/trial-account.ts age ${email} ${TRIAL_DAYS} --apply`);
    console.log('3. Reopen the app. Penny should be telling them the trial is up.');
    process.exit(0);
  }

  if (cmd === 'age') {
    const [email, daysArg] = args;
    if (!email) usage();
    const normalized = email.trim().toLowerCase();
    const days = Number(daysArg ?? TRIAL_DAYS);
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      console.error(`Refusing an age of ${daysArg} days.`);
      process.exit(1);
    }

    const user = await loadUser(normalized, force);
    const target = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    console.log(`user:        ${user.email} (${user.id})`);
    console.log(`created_at:  ${user.createdAt.toISOString()}`);
    console.log(`  ->         ${target.toISOString()}  (${days} days ago)`);

    const [sub] = await db
      .select({ status: subscriptions.status, source: subscriptions.source })
      .from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .limit(1);
    if (sub) {
      console.log('');
      console.log(`NOTE: this account has a subscription row (${sub.status}, ${sub.source}).`);
      console.log('The trial only decides anything when there is no subscription, so aging');
      console.log('will not produce a paywall. Run `reset` first, or use a new address.');
    }

    if (!apply) {
      console.log('');
      console.log('DRY RUN — nothing was written. Re-run with --apply.');
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
    process.exit(0);
  }

  if (cmd === 'reset') {
    const [email] = args;
    if (!email) usage();
    const normalized = email.trim().toLowerCase();
    const user = await loadUser(normalized, force);
    const target = new Date();

    console.log(`user:        ${user.email} (${user.id})`);
    console.log('would clear: subscriptions row, usage_alerts rows');
    console.log(`created_at:  ${user.createdAt.toISOString()} -> ${target.toISOString()} (now)`);
    console.log('');
    console.log('NOT cleared: trips, chat history, usage_events. A reset account is a');
    console.log('fresh TRIAL, not a fresh USER — spend already on the clock still counts');
    console.log('toward the $1 trial ceiling, so a heavily used account can hit the');
    console.log('paywall immediately. Use a new address when that matters.');

    if (!apply) {
      console.log('');
      console.log('DRY RUN — nothing was written. Re-run with --apply.');
      process.exit(0);
    }

    await db.delete(subscriptions).where(eq(subscriptions.userId, user.id));
    await db.delete(usageAlerts).where(eq(usageAlerts.userId, user.id));
    await db.update(users).set({ createdAt: target }).where(eq(users.id, user.id));
    console.log('');
    console.log('DONE. Back to day 0 of a trial.');
    process.exit(0);
  }

  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
