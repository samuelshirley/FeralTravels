import { z } from 'zod';

/**
 * The RevenueCat webhook contract, and only the parts of it we act on.
 *
 * Two opposite pressures shape this file, and the split between them is the
 * whole design:
 *
 * - **Strict on what we use.** `id`, `type` and `app_user_id` decide
 *   idempotency, state and ownership. A body missing any of those cannot be
 *   processed at all, so it is rejected at the boundary rather than turned into
 *   a half-applied subscription — the lockdown invariant in CLAUDE.md, applied
 *   to a payload we do not control.
 *
 * - **Permissive on everything else** (`.passthrough()`, and every optional
 *   field nullish). RevenueCat adds event types and fields without asking us,
 *   and a schema that rejects an unrecognised notification would 400 it — which
 *   RevenueCat reads as a failure and retries, forever, for something we were
 *   never going to act on anyway. An unknown type must PARSE and then be
 *   ignored by the handler; that is a decision, not a validation error.
 *
 * The verbatim body is stored on the event row, so anything we chose not to
 * model here can still be read back later.
 */
export const revenueCatEventSchema = z
  .object({
    /** The store's event id. The idempotency key — retries reuse it. */
    id: z.string().min(1),
    /** e.g. `INITIAL_PURCHASE`, `RENEWAL`, `REFUND`. Unknown values are legal here. */
    type: z.string().min(1),
    /** Our `users.id`: the app calls `Purchases.logIn(users.id)` at sign-in. */
    app_user_id: z.string().min(1),
    /**
     * RevenueCat's first id for this subscriber. Captured, not used: it differs
     * from `app_user_id` only for purchases made before sign-in, which cannot
     * happen while the paywall is behind an authenticated screen. If anonymous
     * purchase is ever allowed, the user lookup grows a fallback to this field.
     */
    original_app_user_id: z.string().nullish(),
    product_id: z.string().nullish(),
    /** When paid access ends → `subscriptions.current_period_end`. */
    expiration_at_ms: z.number().nullish(),
    purchased_at_ms: z.number().nullish(),
    /** The store's own clock. Orders events; ours cannot — see webhook.ts. */
    event_timestamp_ms: z.number().nullish(),
    store: z.string().nullish(),
    /** Apple's stable id across renewals. The join key back to ASSN. */
    original_transaction_id: z.string().nullish(),
    /** `SANDBOX` | `PRODUCTION`. Recorded in the payload for the admin log. */
    environment: z.string().nullish(),
    /** Present on CANCELLATION. See the refund note in webhook.ts. */
    cancel_reason: z.string().nullish(),
  })
  .passthrough();

export const revenueCatWebhookSchema = z
  .object({
    api_version: z.string().nullish(),
    event: revenueCatEventSchema,
  })
  .passthrough();

export type RevenueCatWebhookBody = z.infer<typeof revenueCatWebhookSchema>;

/**
 * What the handler works with: store vocabulary translated once, at the edge,
 * so nothing downstream has to know RevenueCat's field names.
 */
export interface NormalizedSubscriptionEvent {
  eventId: string;
  /** Raw store type, uppercased. Recorded as-is even when we ignore it. */
  type: string;
  appUserId: string;
  productId: string | null;
  /** `expiration_at_ms` as a Date-able number. Null when the event carries none. */
  periodEndMs: number | null;
  /** The STORE's timestamp. This is what makes out-of-order delivery safe. */
  eventTimeMs: number;
  store: string | null;
  originalTransactionId: string | null;
  /** The body exactly as it arrived, for the audit row. */
  payload: unknown;
}

/**
 * `receivedAtMs` is only the last-resort clock.
 *
 * Ordering has to be the store's, because ours is the arrival order and
 * arrival order is precisely what is wrong when a delayed `RENEWAL` lands
 * after a `REFUND`. RevenueCat always sends `event_timestamp_ms`; if it ever
 * does not, `purchased_at_ms` is the next best store-side timestamp, and only
 * then do we fall back to now — treating an untimestamped event as the newest
 * thing we have seen. That fallback is the permissive choice, and it is
 * deliberate: refusing the event instead would drop a real purchase over a
 * missing field.
 */
export function normalizeWebhookEvent(
  body: RevenueCatWebhookBody,
  receivedAtMs: number = Date.now()
): NormalizedSubscriptionEvent {
  const e = body.event;
  return {
    eventId: e.id,
    type: e.type.toUpperCase(),
    appUserId: e.app_user_id,
    productId: e.product_id ?? null,
    periodEndMs: e.expiration_at_ms ?? null,
    eventTimeMs: e.event_timestamp_ms ?? e.purchased_at_ms ?? receivedAtMs,
    store: e.store ?? null,
    originalTransactionId: e.original_transaction_id ?? null,
    payload: body,
  };
}
