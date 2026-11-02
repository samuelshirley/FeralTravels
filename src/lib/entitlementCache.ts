import type { EntitlementPayload } from '../types/entitlement';
import { cacheKeys, getCached, removeCached, revalidate, setCached, useCached } from './resourceCache';

/**
 * The entitlement verdict, held in the resource cache so a screen draws the
 * last verdict on its first frame instead of nothing.
 *
 * ── The rule caching must not break ────────────────────────────────────────
 *
 * Fail OPEN. A failed lookup is treated as entitled, because a phone in a
 * tunnel must not paywall a paying customer; every route that spends money
 * gates itself server-side anyway. So a failed refresh stores nothing AND
 * drops a held "blocked" verdict: a phone that cannot reach the server may
 * keep showing someone as entitled, but must never keep showing anyone as
 * blocked on the strength of an answer it could not refresh.
 *
 * Shared rather than native-only so `entitlementCache.test.ts` executes the
 * shipped rule. The native fetcher (`fetchEntitlement`, null on any failure)
 * is injected by `mobile/lib/entitlement.ts`.
 */
export async function refreshEntitlementWith(
  fetcher: () => Promise<EntitlementPayload | null>
): Promise<EntitlementPayload | null> {
  let payload: EntitlementPayload | null;
  try {
    payload = await revalidate(cacheKeys.entitlement, fetcher, (p) => p !== null);
  } catch {
    payload = null;
  }
  if (payload === null) {
    const held = getCached<EntitlementPayload>(cacheKeys.entitlement);
    if (held && !held.entitled) removeCached(cacheKeys.entitlement);
  }
  return payload;
}

/** Record a verdict learned some other way: a purchase, a restore, a poll. */
export function rememberEntitlement(payload: EntitlementPayload): void {
  setCached(cacheKeys.entitlement, payload);
}

/** The held verdict, re-rendering when it changes. Null: none held, never blocks. */
export function useEntitlement(): EntitlementPayload | null {
  return useCached<EntitlementPayload>(cacheKeys.entitlement) ?? null;
}
