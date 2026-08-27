/**
 * Create one disposable paywall test account and print how to sign in as it.
 *
 *   npm run test-user                    # 7 days old, with a trip
 *   npm run test-user -- --days 0        # a fresh trial instead
 *   npm run test-user -- --no-trip       # nothing to be blocked out of
 *
 * The same code path the admin panel uses — `createTestAccount` — so what this
 * prints is exactly what the button makes. It mints no session: the code below
 * is a real one, typed into the real verify form.
 *
 * Runs against whatever DATABASE_URL points at, which on this machine is PROD.
 */
import 'dotenv/config';
import { createTestAccount } from '../src/server/payments/testAccounts';
import { sendOtpCode } from '../src/server/auth/otp';
import { TRIAL_DAYS } from '../src/server/payments/constants';

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string, fallback: number) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
  };

  // The script is the armed context — it is running with the database
  // credentials already. The env gate exists to keep the DEPLOYED server from
  // offering this, which is a different question.
  process.env.SUBSCRIPTION_TESTING = '1';

  const days = value('days', TRIAL_DAYS);
  const withTrip = !flag('no-trip');

  const account = await createTestAccount({
    ageDays: days,
    subscription: null,
    withTrip,
  });

  let code: string | null = null;
  try {
    code = await sendOtpCode(account.email);
  } catch (err) {
    console.error('Could not send the code:', err instanceof Error ? err.message : err);
  }

  const base = process.env.NEXTAUTH_URL || 'https://www.feraltravels.com';
  const link = `${base}/login/verify?email=${encodeURIComponent(account.email)}`;

  console.log('');
  console.log(`  email  ${account.email}`);
  console.log(`  code   ${code ?? '(send failed — request one at /login)'}`);
  console.log(`  link   ${link}`);
  console.log('');
  console.log(`  ${days} days old${withTrip ? ', with a trip starting two weeks out' : ', no trips'}`);
  console.log('  The code is also in the sam@feraltravels.com inbox.');
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
