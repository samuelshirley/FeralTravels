import { describe, it, expect } from 'vitest';
import { isBlockedWebPath, webAppEnabled, WEB_ALWAYS_ALLOWED } from './webAccess';
import { PUBLIC_PATH_PREFIXES } from './paywallPaths';

/**
 * The web-off switch, and the paths it must never take with it.
 *
 * Two failure modes, and they are not symmetric. Letting a page through that
 * should be blocked is a cosmetic miss. Blocking something on the allowed list
 * is either an App Store rejection or the entire iOS app going dark, and
 * neither announces itself — the app keeps compiling, the tests keep passing,
 * and the first report is a reviewer or a user.
 */
describe('webAppEnabled', () => {
  it('defaults ON, so a missing env var is a working app and not a blank site', () => {
    expect(webAppEnabled({})).toBe(true);
    expect(webAppEnabled({ WEB_APP_ENABLED: undefined })).toBe(true);
  });

  it('is off only for the exact string "0"', () => {
    expect(webAppEnabled({ WEB_APP_ENABLED: '0' })).toBe(false);
    expect(webAppEnabled({ WEB_APP_ENABLED: 'false' })).toBe(true);
    expect(webAppEnabled({ WEB_APP_ENABLED: '' })).toBe(true);
  });
});

describe('isBlockedWebPath', () => {
  /**
   * THE one that takes the product down. The iOS app is nothing but calls to
   * these routes, and it authenticates with a bearer token rather than a
   * cookie, so it cannot be recognised by anything running at the edge.
   */
  it('never blocks anything under /api', () => {
    for (const p of [
      '/api/trips',
      '/api/trip?tripId=x',
      '/api/me/entitlement',
      '/api/me/delete',
      '/api/mobile/otp/send',
      '/api/mobile/oauth/exchange',
      '/api/auth/callback/google',
      '/api/webhooks/revenuecat',
      '/api/legs/abc/fuel-stops',
      '/api/support',
      '/api/purchase/test',
    ]) {
      expect(isBlockedWebPath(p), `${p} must stay reachable — the app lives here`).toBe(false);
    }
  });

  /** Apple App Review and Google brand verification fetch these anonymously. */
  it('never blocks the pages a reviewer is given the URL of', () => {
    for (const p of ['/privacy', '/terms', '/support', '/legal/support-dogs.jpg']) {
      expect(isBlockedWebPath(p), `${p} is submitted to Apple/Google — blocking it is a rejection`).toBe(false);
    }
  });

  it('never blocks sign-in, or the download screen itself', () => {
    expect(isBlockedWebPath('/login')).toBe(false);
    expect(isBlockedWebPath('/login/verify')).toBe(false);
    expect(isBlockedWebPath('/get-the-app')).toBe(false);
  });

  it('blocks every actual app screen', () => {
    for (const p of ['/', '/trips', '/trips/abc-123', '/settings', '/vehicle-setup', '/admin', '/admin/users']) {
      expect(isBlockedWebPath(p), `${p} should show the download screen`).toBe(true);
    }
  });

  /**
   * `/admin` is blocked at the edge on purpose and let back in on the Node
   * side, where the database can answer "is this actually the admin". The edge
   * sees a cookie and cannot tell an admin from anyone else holding one.
   */
  it('blocks /admin at the edge — the real check needs a database', () => {
    expect(isBlockedWebPath('/admin')).toBe(true);
  });

  /**
   * Drift guard. Anything reachable with no session at all must also survive
   * the web being switched off, or turning the web off silently narrows the
   * anonymous surface that App Review depends on.
   */
  it('allows everything the anonymous allowlist already promised', () => {
    for (const p of PUBLIC_PATH_PREFIXES) {
      if (p.startsWith('/api')) continue; // covered unconditionally above
      const probe = p.endsWith('/') ? `${p}x` : p;
      expect(
        isBlockedWebPath(probe),
        `${p} is in PUBLIC_PATH_PREFIXES but WEB_ALWAYS_ALLOWED does not cover it`
      ).toBe(false);
    }
  });

  it('the allowed list has no entry that is not a real prefix', () => {
    for (const p of WEB_ALWAYS_ALLOWED) expect(p.startsWith('/')).toBe(true);
  });
});
