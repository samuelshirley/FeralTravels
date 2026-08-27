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
import type { UIMessage } from "@/components/chat/types";

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
 * Stable id for Penny's paywall bubble. Constant, not generated, because the
 * bubble is derived fresh on every render — a new id each time would make React
 * throw the row away and rebuild it on every keystroke in the composer.
 */
export const PAYWALL_MESSAGE_ID = "paywall-notice";

/**
 * The transcript as it should be RENDERED for this account.
 *
 * DERIVED, never appended. The paywall bubble used to be pushed into chat state
 * by an effect on mount, which raced the effect that loads history: history
 * lands with `setMessages(data.messages)`, a wholesale replace, so whichever
 * request answered last decided whether the user saw the message at all. That
 * is why it survived one visit to the chat and vanished on the next — the same
 * two requests, resolving in the other order.
 *
 * Deriving it here means the bubble is a function of "is this account blocked",
 * which is the thing it is actually reporting. It cannot be lost by a state
 * replace and it cannot be appended twice, because it is not stored anywhere.
 *
 * Still SYNTHETIC: it is never written to `chat_history` (see the `paywall`
 * flag's note in components/chat/types.ts) — a statement about billing at one
 * moment must not sit in a paying subscriber's transcript forever.
 *
 * A transcript that ALREADY carries a paywall bubble is returned untouched:
 * that is the mid-conversation 402, where a real pending assistant bubble was
 * rewritten in place. One block per conversation, never two.
 */
export function withPaywallNotice(
  messages: UIMessage[],
  entitlement: EntitlementPayload | null,
  tripId: string
): UIMessage[] {
  // Null means "not asked yet / couldn't ask" and never blocks — same
  // asymmetry as fetchEntitlement above.
  if (!entitlement || entitlement.entitled) return messages;
  // No server copy, nothing to say. The overlay carries its own fallback; a
  // bubble with no words in it would just look like Penny failed.
  const copy = entitlement.paywall;
  if (!copy) return messages;
  if (messages.some((m) => m.paywall)) return messages;
  return [
    ...messages,
    {
      id: PAYWALL_MESSAGE_ID,
      trip_id: tripId,
      role: "assistant",
      content: copy.message,
      kind: "ai",
      changes_made: null,
      created_at: new Date().toISOString(),
      paywall: true,
    },
  ];
}
