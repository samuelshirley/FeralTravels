import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `requireWebAccess` on both sides of the switch.
 *
 * Production runs with `WEB_APP_ENABLED` unset, which is the web ON since
 * 2026-10-01. Both cases are driven explicitly: unset must return before
 * asking who anyone is, and `'0'` — the kill switch — must turn everyone but
 * the admin away. Found 2026-09-24: a gate that every page called and
 * `webAccessCoverage.test.ts` saw was still inert, because nothing tested the
 * value production actually had.
 */

const mocks = vi.hoisted(() => {
  // Next's redirect() throws to abort the render; the sentinel stands in for it.
  class RedirectSentinel extends Error {
    constructor(public readonly to: string) {
      super(`NEXT_REDIRECT ${to}`);
    }
  }
  return {
    RedirectSentinel,
    auth: vi.fn(),
    isAdminEmail: vi.fn(),
    areTestEndpointsEnabled: vi.fn(),
    isFixtureEmail: vi.fn(),
    redirect: vi.fn((to: string) => {
      throw new RedirectSentinel(to);
    }),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth', () => ({ auth: mocks.auth }));
vi.mock('@/server/auth/admin', () => ({ isAdminEmail: mocks.isAdminEmail }));
vi.mock('@/server/auth/test-endpoints', () => ({
  areTestEndpointsEnabled: mocks.areTestEndpointsEnabled,
  isFixtureEmail: mocks.isFixtureEmail,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { requireAdminSignIn, requireWebAccess } from './webAccess';

const FIXTURE = 'playwright-1-abc@e2e.feraltravels.com';

function signedInAs(email: string | null) {
  mocks.auth.mockResolvedValue(email === null ? null : { user: { email } });
}

beforeEach(() => {
  vi.stubEnv('WEB_APP_ENABLED', '0');
  mocks.auth.mockReset();
  mocks.redirect.mockClear();
  mocks.isAdminEmail.mockReset().mockResolvedValue(false);
  mocks.areTestEndpointsEnabled.mockReset().mockReturnValue(false);
  mocks.isFixtureEmail.mockReset().mockImplementation((e: string) => e === FIXTURE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireWebAccess, WEB_APP_ENABLED=0 (the kill switch)', () => {
  it('sends a signed-in non-admin to the download screen', async () => {
    signedInAs('someone@example.com');
    await expect(requireWebAccess()).rejects.toThrow(mocks.RedirectSentinel);
    expect(mocks.redirect).toHaveBeenCalledWith('/get-the-app');
  });

  it('sends a visitor with no session to the download screen', async () => {
    signedInAs(null);
    await expect(requireWebAccess()).rejects.toThrow(mocks.RedirectSentinel);
    expect(mocks.redirect).toHaveBeenCalledWith('/get-the-app');
  });

  it('lets the admin in', async () => {
    signedInAs('sam@feraltravels.com');
    mocks.isAdminEmail.mockResolvedValue(true);
    await expect(requireWebAccess()).resolves.toBeUndefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('turns a fixture address away where the test endpoints are off, as in production', async () => {
    signedInAs(FIXTURE);
    await expect(requireWebAccess()).rejects.toThrow(mocks.RedirectSentinel);
    expect(mocks.redirect).toHaveBeenCalledWith('/get-the-app');
  });

  it('lets a fixture address in where the test endpoints are armed', async () => {
    signedInAs(FIXTURE);
    mocks.areTestEndpointsEnabled.mockReturnValue(true);
    await expect(requireWebAccess()).resolves.toBeUndefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe.each([
  ['unset (production)', undefined],
  ['=1', '1'],
])('requireWebAccess, WEB_APP_ENABLED %s', (_label, value) => {
  it('lets a signed-in non-admin in without asking who they are', async () => {
    vi.stubEnv('WEB_APP_ENABLED', value);
    signedInAs('someone@example.com');
    await expect(requireWebAccess()).resolves.toBeUndefined();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

/**
 * `requireAdminSignIn` — the door. Found 2026-09-30: a signed-out /admin went to
 * the download screen with the web off, and the download screen has no sign-in.
 * It must answer the same way on both sides of the switch, and it must not
 * decide who is an admin: that stays with each page.
 */
describe.each([
  ['unset (production)', undefined],
  ['=0', '0'],
])('requireAdminSignIn, WEB_APP_ENABLED %s', (_label, value) => {
  beforeEach(() => {
    vi.stubEnv('WEB_APP_ENABLED', value);
  });

  it('sends a visitor with no session to the sign-in form, bound for /admin', async () => {
    signedInAs(null);
    await expect(requireAdminSignIn()).rejects.toThrow(mocks.RedirectSentinel);
    expect(mocks.redirect).toHaveBeenCalledWith('/login?callbackUrl=%2Fadmin');
  });

  it('lets anyone with a session through, without asking whether they are the admin', async () => {
    signedInAs('someone@example.com');
    await expect(requireAdminSignIn()).resolves.toBeUndefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.isAdminEmail).not.toHaveBeenCalled();
  });
});

describe('requireAdminSignIn, session store down', () => {
  it('lets the outage through as an error rather than reading it as signed out', async () => {
    mocks.auth.mockRejectedValue(new Error('SessionStoreUnavailable'));
    await expect(requireAdminSignIn()).rejects.toThrow('SessionStoreUnavailable');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
