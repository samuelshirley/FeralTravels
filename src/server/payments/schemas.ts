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
    /**
     * Our `users.id`: the app calls `Purchases.logIn(users.id)` at sign-in.
     *
     * NULLISH IN THE SCHEMA, REQUIRED IN THE REFINEMENT BELOW — and the reason
     * is `TRANSFER`, which does not carry this field at all. RevenueCat's field
     * reference lists `transferred_from` / `transferred_to` for that event and
     * nothing else identifying, so `z.string().min(1)` here would have 400'd
     * every real transfer at the boundary, and RevenueCat would have retried
     * each one for as long as its backoff allowed. Making it optional for
     * everything would give up the invariant this file exists for, so the
     * exception is written down instead.
     */
    app_user_id: z.string().min(1).nullish(),
    /**
     * TRANSFER only. Arrays, because one Apple ID's purchases can come from or
     * go to more than one app user id.
     *
     * `transferred_from` is the ORIGIN — the account losing the subscription.
     * `transferred_to` is the DESTINATION. Do not infer either from
     * `app_user_id`: it is absent on this event, and the docs describe the
     * webhook as being sent "for the destination user", which is a statement
     * about delivery and not a field.
     */
    transferred_from: z.array(z.string()).nullish(),
    transferred_to: z.array(z.string()).nullish(),
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
  .passthrough()
  /**
   * The strictness the nullish `app_user_id` above gives up, taken back for
   * every event that is not a TRANSFER.
   *
   * A purchase, renewal or refund with no `app_user_id` is unprocessable — we
   * would have no idea whose it is — and rejecting it at the boundary is the
   * lockdown rule in CLAUDE.md applied to a payload we do not control. A
   * TRANSFER instead has to name where the subscription is going, so the same
   * rule points at a different field.
   */
  .superRefine((e, ctx) => {
    if (e.type.toUpperCase() === 'TRANSFER') {
      if (!e.transferred_to?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transferred_to'],
          message: 'TRANSFER must name a destination',
        });
      }
      return;
    }
    if (!e.app_user_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['app_user_id'],
        message: 'app_user_id is required',
      });
    }
  });

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
  /** Null ONLY on TRANSFER, which does not carry it. See the schema. */
  appUserId: string | null;
  /** TRANSFER only: the account(s) losing the subscription. */
  transferredFrom: string[];
  /** TRANSFER only: the account(s) receiving it. Never empty on a TRANSFER. */
  transferredTo: string[];
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
    appUserId: e.app_user_id ?? null,
    transferredFrom: e.transferred_from ?? [],
    transferredTo: e.transferred_to ?? [],
    productId: e.product_id ?? null,
    periodEndMs: e.expiration_at_ms ?? null,
    eventTimeMs: e.event_timestamp_ms ?? e.purchased_at_ms ?? receivedAtMs,
    store: e.store ?? null,
    originalTransactionId: e.original_transaction_id ?? null,
    payload: body,
  };
}
