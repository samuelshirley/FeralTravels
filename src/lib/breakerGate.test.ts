import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CIRCUIT_OPEN_CODE,
  CircuitOpenError,
  RATE_LIMITED_CODE,
  TooManyRequestsError,
} from '@/server/auth/errors';

/**
 * The breakers are only worth their unit tests if they are actually CALLED, and
 * called before the money is spent. That is a property of five files in three
 * different shapes — an API route, two server actions and a native exchange —
 * and there is no type that can express "this happens before that one".
 *
 * So it is asserted as source text, the same way `signOutOnFailureGuard.test.ts`
 * and the other guards in this directory are. The failure this exists to catch is not
 * someone deleting the gate on purpose; it is a refactor that moves the
 * Anthropic call above it, or a new sign-in path added beside the gated ones.
 *
 * Every anchor lookup asserts it was FOUND before it is compared. `indexOf`
 * returns -1 for a string that has drifted, and `-1 < n` is true for every
 * positive n — so a guard that skips that check goes on passing while it
 * guards nothing. That exact failure has already happened once in this repo
 * (the "answered chips are inert" test), which is why it is spelled out here.
 */

const ROOT = join(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * Assert both anchors are in the file and that the first comes first.
 *
 * Anchors are CALL sites (`await foo(`), never bare names. A bare name matches
 * the import at the top of the file, which is always before everything — so a
 * name-based version of this test passed no matter where the call actually
 * was, which is the same class of silent pass the -1 check above guards.
 */
function assertOrder(src: string, first: RegExp, second: RegExp, what: string): void {
  const a = src.search(first);
  const b = src.search(second);
  expect(a, `${what}: ${first} is not in the file at all`).toBeGreaterThan(-1);
  expect(b, `${what}: ${second} is not in the file at all`).toBeGreaterThan(-1);
  expect(a, `${what}: ${first} must come before ${second}`).toBeLessThan(b);
}

/** `await name(` — the call, not the import. */
function call(name: string): RegExp {
  return new RegExp(`await ${name}\\(`);
}

describe('the Penny gate runs before any model call', () => {
  const route = read('src/app/api/trip/replan/route.ts');

  it('is called in the replan route', () => {
    expect(route).toContain('assertPennyGateOpen');
  });

  it('runs before the Anthropic loop starts', () => {
    assertOrder(route, call('assertPennyGateOpen'), /\breplanStream\(/, 'replan route');
  });

  it('runs before the per-user caps, which are the gate it is not', () => {
    // Ordering matters for cost, not correctness: the per-user caps are two
    // database reads, and there is no reason to pay for them on a request the
    // global breaker is about to refuse anyway.
    assertOrder(
      route,
      call('assertPennyGateOpen'),
      /getUserUsageSummary\(userId, 1\)/,
      'replan route'
    );
  });

  it('passes the admin flag, so the operator can still see what is happening', () => {
    expect(route).toMatch(/assertPennyGateOpen\(\s*isAdminUser\s*\)/);
  });
});

describe('the sign-up gate runs before an account can be created', () => {
  const cases: Array<{ file: string; before: string; what: string }> = [
    {
      file: 'src/app/api/mobile/otp/send/route.ts',
      before: 'sendOtpCode',
      what: 'the app’s OTP send',
    },
    {
      file: 'src/app/login/page.tsx',
      before: 'sendOtpCode',
      what: 'the web login form',
    },
    {
      file: 'src/app/login/verify/actions.ts',
      before: 'sendOtpCode',
      what: 'the web resend button',
    },
    {
      file: 'src/app/api/mobile/oauth/exchange/route.ts',
      before: 'createSessionForEmail',
      what: 'the native OAuth exchange',
    },
  ];

  for (const { file, before, what } of cases) {
    it(`is called in ${what} before ${before}`, () => {
      const src = read(file);
      expect(src, `${what}: no sign-up gate at all`).toContain('assertSignupGateOpen');
      assertOrder(src, call('assertSignupGateOpen'), call(before), what);
    });
  }

  it('covers every place in src/ that sends an OTP or mints a session from a provider token', () => {
    /*
     * The list above is hand-written, so this is the half that notices a FIFTH
     * sign-in path being added. It walks the same four files' worth of call
     * sites by searching the app directory, and deliberately allows the two
     * that must stay ungated:
     *
     *  - `api/admin/test-users` — an admin minting a disposable account, which
     *    is the tool for testing this, and is already behind requireAdmin.
     *  - `api/mobile/otp/verify` — verifying a code that was already gated when
     *    it was sent. Gating it again would strand somebody mid-sign-in.
     */
    const ALLOWED_UNGATED = [
      'src/app/api/admin/test-users/route.ts',
      'src/app/api/mobile/otp/verify/route.ts',
    ];
    const senders = grepAppFiles(/\bsendOtpCode\(|\bcreateSessionForEmail\(/);
    const ungated = senders.filter(
      // The CALL, not the name: an unused leftover import would otherwise
      // satisfy this while the gate was gone. Found by mutation-checking it.
      (f) => !ALLOWED_UNGATED.includes(f) && !call('assertSignupGateOpen').test(read(f))
    );
    expect(
      ungated,
      'a new sign-in path can create accounts without passing the sign-up breaker'
    ).toEqual([]);
  });
});

describe('the per-IP limits run on the paths that can be flooded', () => {
  it('counts a Penny turn, before the model loop', () => {
    const route = read('src/app/api/trip/replan/route.ts');
    assertOrder(route, call('assertIpAllowed'), /\breplanStream\(/, 'replan route');
    expect(route).toMatch(/assertIpAllowed\('replan'/);
  });

  it('counts every OTP send on all three send paths', () => {
    /*
     * `otp_send`, not `signup`, and on EVERY send rather than only new
     * addresses: a code is real email to a real inbox, and mailing a stranger a
     * hundred of them is the abuse whether or not they have an account. The
     * narrower account-creation limit is inside `assertSignupGateOpen`.
     */
    for (const file of [
      'src/app/api/mobile/otp/send/route.ts',
      'src/app/login/page.tsx',
      'src/app/login/verify/actions.ts',
    ]) {
      const src = read(file);
      expect(src, `${file}: no per-IP send limit`).toMatch(/assertIpAllowed\('otp_send'/);
      assertOrder(src, call('assertIpAllowed'), call('sendOtpCode'), file);
    }
  });

  it('counts account creation inside the sign-up gate, so a returning user is never counted', () => {
    /*
     * The property, not the call: a per-IP limit of five a day applied to every
     * SIGN-IN would refuse a household, an office or a university on the second
     * cup of coffee. It must sit behind the "does this address already have an
     * account" check.
     */
    const gate = read('src/server/payments/breakerCheck.ts');
    assertOrder(gate, /if \(known\) return;/, /assertIpAllowed\('signup'\)/, 'sign-up gate');
  });
});

describe('a tripped breaker is a 503 and says why', () => {
  it('is 503 — never 401 (the app clears the keychain) and never 402 (the paywall)', () => {
    const err = new CircuitOpenError('anthropic_spend_24h', 3600);
    expect(err.status).toBe(503);
  });

  it('carries the code, the breaker and a poll interval', () => {
    const err = new CircuitOpenError('anthropic_spend_24h', 3600);
    expect(err.details).toEqual({
      code: CIRCUIT_OPEN_CODE,
      breaker: 'anthropic_spend_24h',
      retryAfterSeconds: 3600,
    });
    expect(CIRCUIT_OPEN_CODE).toBe('circuit_open');
  });

  it('tells the user their account is fine, because it is', () => {
    expect(new CircuitOpenError('manual_lock', null).message).toMatch(/nothing is wrong/i);
  });

  it('is a 429 for an IP limit, which is a different fact about a different party', () => {
    // 503 says the app is closed and it is not your fault; 429 says this caller
    // is going too fast. A client can act on the second and only wait out the
    // first, so they must not collapse into one code.
    const err = new TooManyRequestsError('otp_send', 1800);
    expect(err.status).toBe(429);
    expect(err.details).toEqual({
      code: RATE_LIMITED_CODE,
      scope: 'otp_send',
      retryAfterSeconds: 1800,
    });
  });

  it('says "this network", never "you" — a shared address may not be them', () => {
    expect(new TooManyRequestsError('otp_send', 60).message).toMatch(/this network/i);
  });
});

/** Every `.ts`/`.tsx` under `src/app` whose text matches. */
function grepAppFiles(re: RegExp): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      if (re.test(readFileSync(join(ROOT, rel), 'utf8'))) out.push(rel);
    }
  };
  walk('src/app');
  return out.sort();
}

/**
 * WHO THE BREAKERS ARE ALLOWED TO EMAIL.
 *
 * Both rules here are corrections, made after the owner's inbox received
 * `[OPEN] Penny locked by hand: 1 (alert at 1, stop at 1)` from a CI preview.
 * An alert channel that cries wolf on every push is one you filter, and then
 * the alert that mattered is filtered with it.
 */
describe('breaker alerts', () => {
  const SRC = read('src/server/payments/breakerCheck.ts');

  it('never emails about the manual lock', () => {
    // It is open because a human threw it thirty seconds ago. Mailing them is
    // telling somebody what they just did — and the e2e spec throws it on
    // every CI run, so it arrived on every push.
    expect(SRC).toMatch(/if \(status\.id === 'manual_lock'\) continue;/);
    assertOrder(
      SRC,
      /if \(status\.id === 'manual_lock'\) continue;/,
      /sendBreakerEmail\(/,
      'breaker alerting'
    );
  });

  it('emails from PRODUCTION only', () => {
    // A preview's breaker state is a test artifact, and the email carries no
    // environment, so a preview's alert is indistinguishable from production's.
    expect(SRC).toMatch(/function alertsEnabled\(\)[\s\S]{0,120}VERCEL_ENV === 'production'/);
    assertOrder(SRC, /if \(!alertsEnabled\(\)\)/, /sendBreakerEmail\(/, 'breaker alerting');
  });

  it('still LOGS on a deployment that may not email, so the signal is not lost', () => {
    expect(SRC).toMatch(/no email: not production/);
  });

  it('still records who threw the lock, which is the part worth keeping', () => {
    // The email went away; the audit row did not.
    expect(read('src/app/api/admin/penny-lock/route.ts')).toMatch(/admin:penny-lock/);
  });
});
