import { isProductionEnvironment } from '@/server/productionGuard';

/**
 * Whether the trial-state test-account generator (`testAccounts.ts`) may be
 * offered here — asked WITHOUT importing it.
 *
 * That separation is the point. `testAccounts.ts` throws at module load in
 * production (`assertNotProduction`), because it writes subscription rows with
 * `source: 'fake'` and ages accounts, and after the 2026-09-21 wipe every row
 * in production is real. So production code must be able to ask "is the
 * generator available?" without loading the generator: `/admin` renders the
 * block from this, and `/api/admin/test-users` answers 404 from this before it
 * dynamically imports `testAccounts.ts`. `testAccountsProductionGuard.test.ts`
 * holds both halves.
 *
 * This file is what survives of `testPurchase.ts` — the fake purchase route it
 * also armed was removed on 2026-09-21. `SUBSCRIPTION_TESTING=1` now arms ONLY
 * the generator, and production refuses it whatever the variable says.
 */

/**
 * The only addresses the generator will touch. Hardcoded, and no env var can
 * widen it: the `resend` action hands an admin a real sign-in code, so this
 * pattern is the line between "our own test inbox" and "account takeover".
 */
export const TEST_ACCOUNT_EMAIL_PATTERN = /^sam\+trial-[a-z0-9-]{1,40}@feraltravels\.com$/i;

type EnvLike = Record<string, string | undefined>;

export function testAccountsAvailable(env: EnvLike = process.env): boolean {
  return env.SUBSCRIPTION_TESTING === '1' && !isProductionEnvironment(env);
}
