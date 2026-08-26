import { describe, expect, it } from 'vitest';
import { isPaywallExempt, isPublicPath } from './paywallPaths';

/**
 * The regression this file exists for is a rejection, not a bug.
 *
 * `/privacy`, `/terms` and `/support` are the URLs submitted to App Store
 * Connect and to the Google OAuth consent screen, and both are fetched with no
 * session. `e2e/legal-pages.spec.ts` proves the deployed pages answer 200; this
 * proves the ALLOWLIST itself still names them, which is the thing a paywall
 * would edit.
 */
describe('paywall path allowlists', () => {
  for (const path of ['/privacy', '/terms', '/support', '/legal/support-dogs.jpg']) {
    it(`${path} is reachable signed out`, () => {
      expect(isPublicPath(path)).toBe(true);
    });

    it(`${path} is reachable by a signed-in user who is not entitled`, () => {
      expect(isPaywallExempt(path)).toBe(true);
    });
  }

  it('lets a blocked user reach settings and delete their account', () => {
    // Apple guideline 5.1.1(v): a paywall in front of "delete my account" is
    // a rejection.
    expect(isPaywallExempt('/settings')).toBe(true);
    expect(isPaywallExempt('/api/me/delete')).toBe(true);
  });

  it('does not make the app itself public', () => {
    expect(isPublicPath('/trips')).toBe(false);
    expect(isPublicPath('/api/trips')).toBe(false);
    expect(isPublicPath('/admin')).toBe(false);
  });

  it('matches by prefix, not by substring', () => {
    // A path that merely CONTAINS "/privacy" is not the privacy page.
    expect(isPublicPath('/trips/privacy')).toBe(false);
  });
});
