import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { APPLE_RELAY_DOMAIN, isProviderEmailProven } from './emailVerification';

/**
 * The rule that decides whether a provider has actually vouched for an
 * address — and therefore whether an OAuth identity may be linked onto an
 * existing account.
 *
 * It runs on all three sign-in paths, and until this file existed the web one
 * had no test at all. That is the dangerous one in both directions: it is
 * wired into an Auth.js `signIn` callback, so returning `false` produces a
 * generic `AccessDenied` with no way forward, and returning `true` when it
 * should not hands someone another person's trips via
 * `allowDangerousEmailAccountLinking`.
 */

const RELAY = `someone${APPLE_RELAY_DOMAIN}`;

describe('isProviderEmailProven', () => {
  describe('an explicit assertion is honoured, in either type', () => {
    // Google sends a boolean; Apple sends the string. Both, from both.
    it.each([
      ['google', true],
      ['google', 'true'],
      ['apple', true],
      ['apple', 'true'],
    ] as const)('%s + %o -> allowed', (provider, claim) => {
      expect(isProviderEmailProven(provider, claim, 'someone@example.com')).toBe(true);
    });

    it.each([
      ['google', false],
      ['google', 'false'],
      ['apple', false],
      ['apple', 'false'],
    ] as const)('%s + %o -> refused', (provider, claim) => {
      expect(isProviderEmailProven(provider, claim, 'someone@example.com')).toBe(false);
    });
  });

  describe('an absent claim is a refusal, not a shrug', () => {
    // This is the case that shipped as "advisory" in an earlier revision: a
    // token that simply omitted the field minted a session for whatever
    // address it carried.
    it.each([undefined, null, '', 0, 1, 'yes', 'TRUE', {}] as const)(
      'google + %o -> refused',
      (claim) => {
        expect(isProviderEmailProven('google', claim, 'someone@example.com')).toBe(false);
      }
    );

    it('apple + absent, on an ordinary address -> refused', () => {
      expect(isProviderEmailProven('apple', undefined, 'someone@example.com')).toBe(false);
    });

    it('google + absent, even on a relay-looking address -> refused', () => {
      // The exception is Apple's to claim. Google never mints these.
      expect(isProviderEmailProven('google', undefined, RELAY)).toBe(false);
    });
  });

  describe('the Hide My Email exception is scoped to exactly Apple’s domain', () => {
    it('allows an apple relay alias with no claim at all', () => {
      expect(isProviderEmailProven('apple', undefined, RELAY)).toBe(true);
    });

    it('is case- and whitespace-insensitive', () => {
      expect(isProviderEmailProven('apple', undefined, `  SOMEONE${APPLE_RELAY_DOMAIN.toUpperCase()}  `)).toBe(true);
    });

    it('refuses a lookalike domain that merely starts the same way', () => {
      // The leading '@' in APPLE_RELAY_DOMAIN is what makes this a refusal.
      expect(
        isProviderEmailProven('apple', undefined, 'a@privaterelay.appleid.com.attacker.test')
      ).toBe(false);
    });

    it('refuses a subdomain impersonation', () => {
      expect(
        isProviderEmailProven('apple', undefined, 'a@evil-privaterelay.appleid.com')
      ).toBe(false);
    });

    it('an explicit false still wins over the relay domain', () => {
      // Apple saying no outranks the domain saying probably.
      expect(isProviderEmailProven('apple', false, RELAY)).toBe(false);
    });
  });
});

/**
 * The three call sites must not re-implement this. A second copy is how the
 * web and native paths come to disagree about who is allowed in — which is
 * exactly the state this module was extracted from, where the duplication was
 * held together by a comment saying "kept deliberately identical".
 */
describe('nobody re-implements the rule', () => {
  const ROOT = process.cwd();

  /** Comments legitimately DESCRIBE the rule; only code may not restate it. */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  const CALLERS = [
    { rel: 'src/server/auth/oauthIdentity.ts', mayReadClaim: false },
    {
      rel: 'src/server/auth/index.ts',
      /**
       * Exempt, and the exemption is the interesting part: `events.signIn`
       * reads `email_verified` again to decide whether to STAMP
       * users.emailVerified. That is a different decision, taken after this
       * gate has already let the sign-in through — it records what the
       * provider said, it does not decide who gets in.
       */
      mayReadClaim: true,
    },
  ];

  for (const { rel, mayReadClaim } of CALLERS) {
    const source = codeOnly(readFileSync(path.join(ROOT, rel), 'utf8'));

    it(`${rel} delegates to isProviderEmailProven`, () => {
      expect(source).toContain('isProviderEmailProven(');
    });

    it(`${rel} does not hardcode the relay domain`, () => {
      // The domain literal belongs to exactly one module. A second copy is a
      // second place to forget the leading '@'.
      expect(source).not.toContain('privaterelay.appleid.com');
    });

    if (!mayReadClaim) {
      it(`${rel} does not decide on the claim itself`, () => {
        expect(source).not.toMatch(/===\s*['"]true['"]/);
      });
    }
  }
});
