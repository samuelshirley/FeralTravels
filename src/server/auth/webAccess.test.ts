import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `requireWebAccess` with the switch in the state production actually runs:
 * `WEB_APP_ENABLED` unset.
 *
 * Found 2026-09-24: production never had the variable, the switch defaulted ON,
 * and this function returned on its first line for every visitor — so anyone
 * could sign up at /login and use the whole web app. Every page called it and
 * `webAccessCoverage.test.ts` was green; the gate was present and inert. These
 * tests drive it with the variable absent, so a default that opens the web
 * fails here rather than in production.
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

import { requireWebAccess } from './webAccess';

const FIXTURE = 'playwright-1-abc@e2e.feraltravels.com';

function signedInAs(email: string | null) {
  mocks.auth.mockResolvedValue(email === null ? null : { user: { email } });
}

beforeEach(() => {
  vi.stubEnv('WEB_APP_ENABLED', undefined);
  mocks.auth.mockReset();
  mocks.redirect.mockClear();
  mocks.isAdminEmail.mockReset().mockResolvedValue(false);
  mocks.areTestEndpointsEnabled.mockReset().mockReturnValue(false);
  mocks.isFixtureEmail.mockReset().mockImplementation((e: string) => e === FIXTURE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireWebAccess, WEB_APP_ENABLED unset (production)', () => {
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

describe('requireWebAccess, WEB_APP_ENABLED=1', () => {
  it('lets a signed-in non-admin in without asking who they are', async () => {
    vi.stubEnv('WEB_APP_ENABLED', '1');
    signedInAs('someone@example.com');
    await expect(requireWebAccess()).resolves.toBeUndefined();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
