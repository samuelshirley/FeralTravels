import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CIRCUIT_OPEN_CODE, CircuitOpenError } from '@/server/auth/errors';

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
