/**
 * Guards the guard: the fixture endpoints must be provably inert on
 * production, regardless of ANY env combination — including hostile ones
 * (someone setting E2E_TEST_ENDPOINTS=1 on prod, or resurrecting the old
 * AUTH_TEST_BACKDOOR_ON_VERCEL_PROD override).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { areTestEndpointsEnabled, isTestRequestAuthorized } from './test-endpoints';

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
