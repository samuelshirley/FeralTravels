/**
 * The App Store review sign-in is exactly one address, one code, one switch.
 *
 * `docs/design/ios-review-notes.md` §1 used to say there was deliberately no
 * demo account, because App Store Connect's Sign-In Information form wants a
 * username and a password and this app is passwordless. That position was
 * reversed on 2026-09-20 and §1 rewritten; this guard is the other half of the
 * reversal — the thing that keeps the reversal narrow.
 *
 * What must stay true:
 *
 *   1. With `APPLE_REVIEW_SIGNIN` unset, `000000` does nothing for anybody,
 *      including the review address. The feature is off by default.
 *   2. With it armed, EXACTLY one address is accepted. The near-misses are
 *      tested explicitly because the way this kind of check goes wrong is a
 *      substring match: `appletest@feraltravels.com.evil.com` ends with a
 *      domain we own if you use `includes`, and `appletest@gmail.com` shares a
 *      local part. Case is ignored, like the rest of the auth surface.
 *   3. The address and the code are LITERALS in source, not read from env. The
 *      switch may only turn the feature off; it may never choose a different
 *      address or a different code.
 *   4. The account gets neither the admin flag nor the comped flag. Comping it
 *      would put it past every paywall, which recreates the "we were unable to
 *      locate the in-app purchases" rejection that §2 of the review notes is
 *      about — an entitled account sees no prices.
 *
 * Mutation-checked: the env gate, the exact-match comparison, the hardcoded
 * code and the admin/comped exclusions were each broken in turn, and this file
 * went red on that property alone.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The same escape hatch `server/auth/test-endpoints.test.ts` uses, for the same
// reason: the module under test is correctly `server-only`, and the unit
// project is a node environment that would otherwise refuse to import it.
vi.mock('server-only', () => ({}));

import {
  REVIEW_ACCOUNT_CODE,
  REVIEW_ACCOUNT_EMAIL,
  isReviewAccountEmail,
  isReviewAccountSignIn,
  isReviewSignInArmed,
} from '@/server/auth/reviewAccount';
import { FIXTURE_EMAIL_PATTERN } from '@/server/auth/test-endpoints';

const ROOT = join(__dirname, '..', '..');
const ARMED = { APPLE_REVIEW_SIGNIN: '1' };

describe('the switch can only turn it off', () => {
  it('does nothing at all when the flag is unset', () => {
    expect(isReviewSignInArmed({})).toBe(false);
    expect(isReviewAccountSignIn(REVIEW_ACCOUNT_EMAIL, {})).toBe(false);
  });

  it('does nothing for any other value of the flag', () => {
    for (const v of ['0', 'true', 'yes', '', ' 1', 'TRUE', 'on']) {
      expect(isReviewAccountSignIn(REVIEW_ACCOUNT_EMAIL, { APPLE_REVIEW_SIGNIN: v })).toBe(false);
    }
  });

  it('arms for the one address when the flag is exactly "1"', () => {
    expect(isReviewAccountSignIn(REVIEW_ACCOUNT_EMAIL, ARMED)).toBe(true);
  });
});

describe('exactly one address is accepted', () => {
  it('accepts it case-insensitively, like the rest of the auth surface', () => {
    for (const v of [
      'Appletest@feraltravels.com',
      'APPLETEST@FERALTRAVELS.COM',
      '  appletest@feraltravels.com  ',
    ]) {
      expect(isReviewAccountSignIn(v, ARMED)).toBe(true);
    }
  });

  it('rejects the near-misses a substring check would let through', () => {
    for (const v of [
      // The one that matters: ends with a domain we own, if you use `includes`.
      'appletest@feraltravels.com.evil.com',
      'appletest@gmail.com',
      'appletest@feraltravels.com.co',
      'xappletest@feraltravels.com',
      'appletest@e2e.feraltravels.com',
      'appletest+1@feraltravels.com',
      'appletest@sub.feraltravels.com',
      'sam@feraltravels.com',
      '',
      null,
      undefined,
    ]) {
      expect(isReviewAccountSignIn(v, ARMED), `${v} must be rejected`).toBe(false);
    }
  });

  it('the address test alone is still exact, with no flag involved', () => {
    expect(isReviewAccountEmail(REVIEW_ACCOUNT_EMAIL)).toBe(true);
    expect(isReviewAccountEmail('appletest@feraltravels.com.evil.com')).toBe(false);
  });
});

describe('the address and the code are literals, not configuration', () => {
  const source = readFileSync(join(ROOT, 'src/server/auth/reviewAccount.ts'), 'utf8');

  it('are hardcoded in source', () => {
    expect(REVIEW_ACCOUNT_EMAIL).toBe('appletest@feraltravels.com');
    expect(REVIEW_ACCOUNT_CODE).toBe('000000');
    expect(source).toMatch(/REVIEW_ACCOUNT_EMAIL\s*=\s*'appletest@feraltravels\.com'/);
    expect(source).toMatch(/REVIEW_ACCOUNT_CODE\s*=\s*'000000'/);
  });

  it('reads no environment variable other than the off switch', () => {
    // Any other env read here would be a way to choose the address or the
    // code from a dashboard, which is the whole thing this must not become.
    const envReads = [...source.matchAll(/env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]);
    expect([...new Set(envReads)]).toEqual(['APPLE_REVIEW_SIGNIN']);
  });

  it('is one string, not a pattern or a list', () => {
    // A regex or an array here would be a widenable surface.
    expect(source).not.toMatch(/REVIEW_ACCOUNT_EMAIL\s*(:[^=]*)?=\s*[[/]/);
  });
});

describe('the review account is an ordinary trial account', () => {
  // Read as SOURCE rather than imported: `admin.ts` and `comped.ts` both pull
  // in the db client, and a guard about two hardcoded allowlists should not
  // need a database to answer. Both lists are literal arrays, so the absence
  // of this address from the file is the whole fact.
  const admin = readFileSync(join(ROOT, 'src/server/auth/admin.ts'), 'utf8');
  const comped = readFileSync(join(ROOT, 'src/server/payments/comped.ts'), 'utf8');

  it('is not on the admin allowlist', () => {
    expect(admin).toMatch(/ADMIN_ALLOWLIST/);
    expect(admin).not.toContain(REVIEW_ACCOUNT_EMAIL);
  });

  it('is not on the comped allowlist, so it still sees the paywall and can buy', () => {
    // If it were comped the reviewer would be entitled, every paywall would be
    // hidden from them, and the only place a price appears is Settings -> Plan
    // -> View plans. That is the "unable to locate the in-app purchases"
    // rejection §2 of the review notes is about.
    expect(comped).toMatch(/COMPED_ALLOWLIST/);
    expect(comped).not.toContain(REVIEW_ACCOUNT_EMAIL);
  });

  it('is unrelated to the E2E fixture family', () => {
    // `isCompedEmail` also comps anything matching the fixture pattern, and
    // the `/api/test/*` endpoints will read back a fixture address's code.
    // This address must be neither.
    expect(FIXTURE_EMAIL_PATTERN.test(REVIEW_ACCOUNT_EMAIL)).toBe(false);
  });
});

describe('it is wired into the two places that matter, and only under the flag', () => {
  const otp = readFileSync(join(ROOT, 'src/server/auth/otp.ts'), 'utf8');
  const breaker = readFileSync(join(ROOT, 'src/server/payments/breakerCheck.ts'), 'utf8');

  it('verifyOtpCode accepts the fixed code only via isReviewAccountSignIn', () => {
    const fn = otp.slice(otp.indexOf('export async function verifyOtpCode'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).toMatch(/isReviewAccountSignIn\(normalized\)\s*&&\s*submitted === REVIEW_ACCOUNT_CODE/);
  });

  it('sendOtpCode skips the transport and the ladder for it', () => {
    const fn = otp.slice(otp.indexOf('export async function sendOtpCode'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    const guard = body.indexOf('isReviewAccountSignIn(normalized)');
    const ladder = body.indexOf('claimSendSlot');
    expect(guard).toBeGreaterThan(-1);
    // Before the ladder: a reviewer tapping "resend" must not lock themselves
    // out of the account they were given.
    expect(guard).toBeLessThan(ladder);
  });

  it('the sign-up breaker exempts it, or a reviewer is refused on first use', () => {
    expect(breaker).toMatch(/isReviewAccountSignIn\(normalized\)\)\s*return;/);
  });

  it('nothing else in src/ consults it', () => {
    // Three call sites, by design. A fourth is a new place this address is
    // special, and should be a deliberate decision rather than a diff nobody
    // reads.
    const files = ['src/server/auth/otp.ts', 'src/server/payments/breakerCheck.ts'];
    const callers = files.filter((f) =>
      readFileSync(join(ROOT, f), 'utf8').includes('isReviewAccountSignIn'),
    );
    expect(callers.sort()).toEqual(files.sort());
  });
});
