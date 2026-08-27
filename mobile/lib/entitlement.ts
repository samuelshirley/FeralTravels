import { apiFetch, ApiError } from "@/lib/api";
/**
 * Relative rather than `@/shared/types/entitlement`, unlike its neighbours.
 *
 * `withPaywallNotice` below is the one piece of the native paywall the unit
 * suite can actually execute — there is no React Native test runner in this
 * repo — and the root Vitest config aliases `@` to the WEB app's `src`, where
 * `shared/` does not exist. A relative specifier resolves identically for Expo
 * and for the test runner, which is what makes that function testable at all.
 */
import type { EntitlementPayload } from "../shared/types/entitlement";
import { PAYWALL_ERROR_CODE } from "../shared/types/entitlement";

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

/**
 * The paywall bubble derivation now lives in `shared/lib/paywallNotice.ts` and
 * is re-exported here so this module's surface is unchanged.
 *
 * It moved because the root vitest project could not test it where it was: the
 * suite transforms whatever it imports, `mobile/tsconfig.json` extends
 * `expo/tsconfig.base`, and CI's unit job never installs `mobile/node_modules`
 * — so importing this file from a root test failed with "Tsconfig not found".
 * Locally both trees are installed, which is exactly why it passed here and
 * broke there. Shared logic goes in the mirror; the mirror-drift guard then
 * keeps the two copies honest.
 */
export { PAYWALL_MESSAGE_ID, withPaywallNotice } from "@/shared/lib/paywallNotice";
export type { PaywallNoticeMessage } from "@/shared/lib/paywallNotice";
