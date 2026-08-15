/**
 * Guards the guard: the fixture endpoints must be provably inert on
 * production, regardless of ANY env combination — including hostile ones
 * (someone setting E2E_TEST_ENDPOINTS=1 on prod, or resurrecting the old
 * AUTH_TEST_BACKDOOR_ON_VERCEL_PROD override).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { areTestEndpointsEnabled, isTestRequestAuthorized, isFixtureEmail, isFixtureRecipient } from './test-endpoints';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/test/seed', { method: 'POST', headers });
}

describe('areTestEndpointsEnabled', () => {
  it('is OFF by default (empty env)', () => {
    expect(areTestEndpointsEnabled({})).toBe(false);
  });

  it('is ON only with the explicit flag, off production', () => {
    expect(areTestEndpointsEnabled({ E2E_TEST_ENDPOINTS: '1' })).toBe(true);
    expect(areTestEndpointsEnabled({ E2E_TEST_ENDPOINTS: '1', VERCEL_ENV: 'preview' })).toBe(true);
    expect(areTestEndpointsEnabled({ E2E_TEST_ENDPOINTS: '1', VERCEL_ENV: 'development' })).toBe(true);
  });

  it('does not accept truthy-ish values other than "1"', () => {
    expect(areTestEndpointsEnabled({ E2E_TEST_ENDPOINTS: 'true' })).toBe(false);
    expect(areTestEndpointsEnabled({ E2E_TEST_ENDPOINTS: 'yes' })).toBe(false);
  });

  it('is ALWAYS off on Vercel production — no env combination can enable it', () => {
    const hostileAttempts: Array<Record<string, string>> = [
      { VERCEL_ENV: 'production', E2E_TEST_ENDPOINTS: '1' },
      { VERCEL_ENV: 'production', E2E_TEST_ENDPOINTS: '1', E2E_TEST_ENDPOINTS_SECRET: 's3cret' },
      // The old backdoor had a prod override — assert nothing like it works.
      { VERCEL_ENV: 'production', E2E_TEST_ENDPOINTS: '1', AUTH_TEST_BACKDOOR_ON_VERCEL_PROD: '1' },
      { VERCEL_ENV: 'production', E2E_TEST_ENDPOINTS: '1', E2E_TEST_ENDPOINTS_ON_VERCEL_PROD: '1' },
      { VERCEL_ENV: 'production', E2E_TEST_ENDPOINTS: '1', NODE_ENV: 'test' },
    ];
    for (const env of hostileAttempts) {
      expect(areTestEndpointsEnabled(env), JSON.stringify(env)).toBe(false);
    }
  });
});

describe('isTestRequestAuthorized', () => {
  it('rejects everything when disabled, even with a matching secret header', () => {
    expect(isTestRequestAuthorized(req(), {})).toBe(false);
    expect(
      isTestRequestAuthorized(req({ 'x-e2e-test-secret': 's' }), {
        VERCEL_ENV: 'production',
        E2E_TEST_ENDPOINTS: '1',
        E2E_TEST_ENDPOINTS_SECRET: 's',
      }),
    ).toBe(false);
  });

  it('allows when enabled and no secret is configured (local runs)', () => {
    expect(isTestRequestAuthorized(req(), { E2E_TEST_ENDPOINTS: '1' })).toBe(true);
  });

  it('requires the exact secret header when a secret is configured', () => {
    const env = { E2E_TEST_ENDPOINTS: '1', E2E_TEST_ENDPOINTS_SECRET: 'per-run' };
    expect(isTestRequestAuthorized(req(), env)).toBe(false);
    expect(isTestRequestAuthorized(req({ 'x-e2e-test-secret': 'wrong' }), env)).toBe(false);
    expect(isTestRequestAuthorized(req({ 'x-e2e-test-secret': 'per-run' }), env)).toBe(true);
  });
});

describe('isFixtureEmail', () => {
  it('accepts only the playwright-* @e2e subdomain shape', () => {
    expect(isFixtureEmail('playwright-abc123-0@e2e.feraltravels.com')).toBe(true);
    expect(isFixtureEmail('PLAYWRIGHT-ABC@E2E.FERALTRAVELS.COM')).toBe(true);
  });

  it('refuses real accounts, near-misses and lookalike domains', () => {
    for (const email of [
      'sam@feraltravels.com',
      'playwright-abc@feraltravels.com', // right prefix, WRONG (real) domain
      'someone@e2e.feraltravels.com', // right domain, wrong prefix
      'playwright-abc@e2e.feraltravels.com.evil.tld',
      'playwright-abc@e2eXferaltravels.com', // the dot must be a dot
      'a@b.c',
      '',
    ]) {
      expect(isFixtureEmail(email), email).toBe(false);
    }
  });
});

describe('isFixtureRecipient', () => {
  it('needs BOTH the fixture shape and test endpoints enabled', () => {
    const on = { E2E_TEST_ENDPOINTS: '1' };
    expect(isFixtureRecipient('playwright-a@e2e.feraltravels.com', on)).toBe(true);
    expect(isFixtureRecipient('sam@feraltravels.com', on)).toBe(false);
    expect(isFixtureRecipient('playwright-a@e2e.feraltravels.com', {})).toBe(false);
  });

  it('is ALWAYS false on Vercel production, even for fixture addresses', () => {
    // The invariant that keeps a fixture-shaped address from ever suppressing
    // a real send, or being readable, on production.
    for (const env of [
      { VERCEL_ENV: 'production', E2E_TEST_ENDPOINTS: '1' },
      { VERCEL_ENV: 'production', E2E_TEST_ENDPOINTS: '1', E2E_TEST_ENDPOINTS_SECRET: 'x' },
    ]) {
      expect(isFixtureRecipient('playwright-a@e2e.feraltravels.com', env)).toBe(false);
    }
  });
});
