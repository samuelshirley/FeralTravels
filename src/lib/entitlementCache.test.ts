/**
 * Caching the entitlement verdict must not break the fail-open rule: a failed
 * lookup never blocks anyone, even when the last verdict on file says blocked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntitlementPayload } from '../types/entitlement';
import { refreshEntitlementWith, rememberEntitlement } from './entitlementCache';
import { cacheKeys, configureResourceCachePersistence, getCached, resetResourceCache } from './resourceCache';

const verdict = (entitled: boolean) => ({ entitled }) as EntitlementPayload;

beforeEach(() => {
  configureResourceCachePersistence(null);
  resetResourceCache();
});

describe('refreshEntitlementWith', () => {
  it('stores a fresh verdict', async () => {
    await refreshEntitlementWith(async () => verdict(false));
    expect(getCached<EntitlementPayload>(cacheKeys.entitlement)?.entitled).toBe(false);
  });

  it('a failed lookup DROPS a held blocked verdict (fail open)', async () => {
    rememberEntitlement(verdict(false));
    await refreshEntitlementWith(async () => null);
    expect(getCached(cacheKeys.entitlement)).toBeUndefined();
  });

  it('a failed lookup keeps a held entitled verdict', async () => {
    rememberEntitlement(verdict(true));
    await refreshEntitlementWith(async () => null);
    expect(getCached<EntitlementPayload>(cacheKeys.entitlement)?.entitled).toBe(true);
  });

  it('a fetcher that throws is a failed lookup, not a crash', async () => {
    rememberEntitlement(verdict(false));
    await expect(refreshEntitlementWith(() => Promise.reject(new Error('offline')))).resolves.toBeNull();
    expect(getCached(cacheKeys.entitlement)).toBeUndefined();
  });
});
