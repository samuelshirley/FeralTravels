import { apiFetch, ApiError } from "@/lib/api";
import type { EntitlementPayload } from "@/shared/types/entitlement";
import { PAYWALL_ERROR_CODE } from "@/shared/types/entitlement";

export type { EntitlementPayload };
export { PAYWALL_ERROR_CODE };

/**
 * Ask the server what this account is allowed to do.
 *
 * The client is never the authority here — this is the app finding out, not
 * deciding. Every route that spends money gates itself server-side, so a
 * failure to fetch this must NEVER be treated as "blocked": an unreachable
 * entitlement endpoint would otherwise paywall the whole app the moment the
 * network hiccups.
 *
 * `skipGlobalErrorReport` because a failure here is silent by design. The user
 * has not asked for anything yet.
 */
export async function fetchEntitlement(): Promise<EntitlementPayload | null> {
  try {
    return await apiFetch<EntitlementPayload>("/api/me/entitlement", {
      skipGlobalErrorReport: true,
    });
  } catch {
    return null;
  }
}

/**
 * Grant a subscription without Apple. Allowlisted server-side; the server
 * refuses if this account is not on the list, whatever the app claims.
 *
 * Exists only because StoreKit returns an EMPTY product list until the Paid
 * Applications Agreement is active, so there is no real purchase sheet to test
 * against yet. Deleting this is the last step of the RevenueCat migration —
 * docs/design/revenuecat-implementation.md.
 */
export async function testPurchase(productId: string): Promise<void> {
  await apiFetch("/api/purchase/test", { method: "POST", body: { productId } });
}

/**
 * True when a thrown ApiError is the paywall rather than any other 402.
 *
 * Branches on the machine-readable `code`, never on the message — the message
 * is copy, and copy is meant to change without breaking clients.
 */
export function isPaywallError(err: unknown): err is ApiError {
  if (!(err instanceof ApiError) || err.status !== 402) return false;
  const payload = err.payload as { code?: string } | null;
  return payload?.code === PAYWALL_ERROR_CODE;
}
