import type { EntitlementPayload } from '@/types/entitlement';

/**
 * Penny's paywall bubble, derived rather than stored — shared by both clients.
 *
 * WHY IT IS DERIVED. The bubble used to be pushed into ChatPanel's message
 * state by an effect on mount. That effect raced the one that loads chat
 * history, which lands with `setMessages(data.messages)` — a wholesale
 * replace. Whichever request answered last decided whether the user saw the
 * message, so it appeared on one visit to the chat and was silently gone on
 * the next. Deriving it makes the bubble a function of "is this account
 * blocked", which is the thing it actually reports: it cannot be lost by a
 * state replace and it cannot be appended twice, because it is not stored.
 *
 * WHY IT LIVES IN `src/lib/` AND IS MIRRORED. It was written twice — once in
 * `mobile/lib/entitlement.ts` and once inline in the web ChatPanel — and the
 * test for it had to reach across into `mobile/` to find the real function.
 * That reach is what broke CI: the root vitest project transforms whatever it
 * imports, `mobile/tsconfig.json` extends `expo/tsconfig.base`, and the unit
 * job never installs `mobile/node_modules`, so the transform failed with
 * "Tsconfig not found". It passed locally only because a developer machine
 * has both trees installed.
 *
 * So the rule this file encodes: **the root test suite must never import from
 * `mobile/`.** Shared logic belongs in the mirror, where `sync-shared.mjs`
 * copies it and `sharedMirror.test.ts` fails the build if the two drift.
 *
 * The bubble stays SYNTHETIC either way — never written to `chat_history`. A
 * statement about billing at one moment must not sit in a paying subscriber's
 * transcript forever.
 */

/**
 * Stable id, not a generated one, because the bubble is derived fresh on every
 * render — a new id each time would make React throw the row away and rebuild
 * it on every keystroke in the composer.
 */
export const PAYWALL_MESSAGE_ID = 'paywall-notice';

/** The fields this derivation needs. Both platforms' message types are supersets. */
export interface PaywallNoticeMessage {
  id: string;
  trip_id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: string;
  changes_made: string | null;
  created_at: string;
  /** UI-only marker. Never persisted — see the `paywall` note on each client's message type. */
  paywall?: boolean;
}

export function withPaywallNotice<T extends PaywallNoticeMessage>(
  messages: T[],
  entitlement: Pick<EntitlementPayload, 'entitled' | 'paywall'> | null,
  tripId: string,
  /**
   * Injected so the output is a pure function of its inputs.
   *
   * The bubble is synthetic and its timestamp is never read by anything that
   * matters, but a function that reaches for the ambient clock cannot be
   * asserted on without freezing time around it — and a test that has to
   * freeze time to be true is a test that will differ between a laptop and a
   * CI box for reasons unrelated to the code.
   */
  nowISO: string = new Date().toISOString()
): T[] {
  // Null means "not asked yet / couldn't ask", and never blocks. An
  // unreachable entitlement endpoint must not paywall the app.
  if (!entitlement || entitlement.entitled) return messages;

  // No server copy, nothing to say. The overlay carries its own fallback; a
  // bubble with no words in it would just look like Penny failed.
  const copy = entitlement.paywall;
  if (!copy) return messages;

  // A transcript that ALREADY carries one is returned untouched: that is the
  // mid-conversation 402, where a real pending assistant bubble was rewritten
  // in place. One block per conversation, never two.
  if (messages.some((m) => m.paywall)) return messages;

  const notice: PaywallNoticeMessage = {
    id: PAYWALL_MESSAGE_ID,
    trip_id: tripId,
    role: 'assistant',
    content: copy.message,
    kind: 'ai',
    changes_made: null,
    created_at: nowISO,
    paywall: true,
  };

  // The one cast in this file. `T` is a superset of the base shape on both
  // platforms, and every field either type adds beyond it is optional and
  // meaningless on a synthetic bubble (no seq, no plan_summary, no delivery
  // status). Returning `(T | PaywallNoticeMessage)[]` instead would push that
  // same widening onto every `.map` in both renderers.
  return [...messages, notice as T];
}
