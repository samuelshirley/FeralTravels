import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { subscriptionEvents, subscriptions, users } from '@/server/db/schema';
import type { SubscriptionStatus } from '@/server/db/schema';
import { upsertSubscription, type UpsertSubscriptionInput } from './entitlements';
import type { NormalizedSubscriptionEvent } from './schemas';

/**
 * The RevenueCat webhook handler: a store notification in, a subscription row
 * out.
 *
 * This is the ONLY thing that may grant paid access. The app can claim it
 * bought something; a receipt it hands us is a claim, not proof. The webhook
 * arrives from RevenueCat over a shared secret, and it is what the server
 * believes.
 *
 * Structure follows `oauthReplay.ts`: a pure decision function that knows the
 * rules, a deps seam for the four database facts it needs, and defaults that
 * are the only implementation shipping. The reason is the same one — every
 * property worth pinning here is about which check runs first and what it does
 * with the answer (a duplicate must change nothing, a stale event must not
 * resurrect access), and a real Postgres would be testing drizzle rather than
 * any of that. `states.ts` makes the same split for the same reason.
 */

/** What we did with an event. Written verbatim to `subscription_events.outcome`. */
export type WebhookOutcome =
  | 'applied'
  | 'ignored_duplicate'
  | 'ignored_stale'
  | 'ignored_unknown_type'
  /**
   * The event names an `app_user_id` we have no user for — a deleted account,
   * or a subscriber from another RevenueCat project pointed at this URL. Kept
   * DISTINCT from `ignored_unknown_type` (which the schema comment enumerates)
   * because the admin log has to be able to tell "RevenueCat sent us a
   * notification we don't handle" from "somebody paid and we cannot find
   * them" — the second is worth investigating and the first is not.
   */
  | 'ignored_unknown_user';

export interface WebhookResult {
  outcome: WebhookOutcome;
  eventId: string;
  /** Null when the event named a user we do not have. */
  userId: string | null;
  /** The status written, on `applied` only. */
  status: SubscriptionStatus | null;
}

export type IgnoredReason = Extract<
  WebhookOutcome,
  'ignored_stale' | 'ignored_unknown_type' | 'ignored_unknown_user'
>;

export type EventDecision =
  | { action: 'apply'; status: SubscriptionStatus; autoRenew: boolean; periodEnd: Date | null }
  /** A move between two accounts. See `applyTransfer`. */
  | { action: 'transfer' }
  | { ignored: IgnoredReason };

/**
 * Store notification type → what the subscription row should say.
 *
 * The four distinctions this table encodes are the ones docs/design/
 * subscriptions.md exists to keep straight, and getting any of them wrong
 * either takes money for access we withhold or gives away access we were paid
 * for once:
 *
 * - **CANCELLATION is not expiry.** The user turned off auto-renew; they have
 *   already paid through `expiration_at_ms` and cancelling returns no money.
 *   So the status stays `active` and only `autoRenew` flips — the resolver in
 *   `states.ts` derives `cancelled_in_period` from that pair and keeps them
 *   entitled until the period actually ends. Writing `expired` here would cut
 *   off someone 362 days into an annual plan they paid for in full.
 * - **EXPIRATION is the period genuinely ending.** Now they hit the paywall.
 * - **BILLING_ISSUE is grace**, which Apple and RevenueCat both report as
 *   still-entitled, and `states.ts` treats it that way. There is no path into
 *   this state without a successful payment first.
 * - **REFUND revokes immediately**, no grace. Apple decides refunds, not us;
 *   we find out afterwards and honour it.
 *
 * NOT handled, on purpose: RevenueCat also signals an Apple-support refund as
 * a `CANCELLATION` carrying `cancel_reason: 'CUSTOMER_SUPPORT'`. Branching on
 * that would silently change what CANCELLATION means, so it stays a documented
 * follow-up — the admin break-glass revoke covers it in the meantime, and the
 * raw payload with `cancel_reason` is on the event row to find it by.
 *
 * `TRANSFER` is not in this table either, but it IS handled — see
 * `applyTransfer`. It maps to no single status because it concerns two users.
 */
const TYPE_MAP: Readonly<Record<string, { status: SubscriptionStatus; autoRenew: boolean }>> = {
  INITIAL_PURCHASE: { status: 'active', autoRenew: true },
  RENEWAL: { status: 'active', autoRenew: true },
  PRODUCT_CHANGE: { status: 'active', autoRenew: true },
  UNCANCELLATION: { status: 'active', autoRenew: true },
  CANCELLATION: { status: 'active', autoRenew: false },
  EXPIRATION: { status: 'expired', autoRenew: false },
  BILLING_ISSUE: { status: 'grace', autoRenew: true },
  REFUND: { status: 'refunded', autoRenew: false },
};

/**
 * `TRANSFER` is handled, but NOT through `TYPE_MAP`.
 *
 * Every other type maps to a status for ONE user. A transfer is a move between
 * two, and it carries no status of its own — so it has its own branch below and
 * is listed here only so it stops being logged as an unhandled type.
 */
export const TRANSFER = 'TRANSFER';

/** Types RevenueCat sends that we knowingly do nothing with. */
export function isKnownEventType(type: string): boolean {
  return type in TYPE_MAP || type === TRANSFER;
}

/**
 * The whole rule set, with no database in it.
 *
 * `lastAppliedEventTimeMs` is the store timestamp of the newest event we
 * actually applied for this user, or null if there is none.
 */
export function decideFromEvent(
  event: NormalizedSubscriptionEvent,
  lastAppliedEventTimeMs: number | null
): EventDecision {
  // A transfer is decided in `applyTransfer`, not here: it maps to no single
  // status and concerns two users. It still has to pass the staleness check
  // below, so it is short-circuited rather than dropped.
  if (event.type === TRANSFER) {
    if (lastAppliedEventTimeMs !== null && event.eventTimeMs < lastAppliedEventTimeMs) {
      return { ignored: 'ignored_stale' };
    }
    return { action: 'transfer' };
  }

  const mapped = TYPE_MAP[event.type];

  // Type first: an event we do not understand tells us nothing about ordering
  // either, so there is no point asking whether it is stale. This also keeps
  // the recorded outcome a function of the type alone, which is what makes the
  // admin log readable.
  if (!mapped) return { ignored: 'ignored_unknown_type' };

  // Delivery order is not event order. A `RENEWAL` delayed in flight can land
  // after the `REFUND` that revoked the account, and applying it would hand
  // back access Apple has already refunded. Strictly older loses; equal
  // timestamps do not, because two distinct events can share a millisecond and
  // dropping the second would lose a real state change.
  if (lastAppliedEventTimeMs !== null && event.eventTimeMs < lastAppliedEventTimeMs) {
    return { ignored: 'ignored_stale' };
  }

  return {
    action: 'apply',
    status: mapped.status,
    autoRenew: mapped.autoRenew,
    periodEnd: event.periodEndMs === null ? null : new Date(event.periodEndMs),
  };
}

/** What the current row already knows, so an event missing a field cannot erase it. */
export interface ExistingSubscription {
  currentPeriodEnd: Date | null;
  productId: string | null;
  originalTransactionId: string | null;
}

export interface WebhookDeps {
  /** `users.id` for a RevenueCat `app_user_id`, or null when we have no such user. */
  findUserId?: (appUserId: string) => Promise<string | null>;
  /** Store timestamp of the newest event we APPLIED for this user. */
  lastAppliedEventTimeMs?: (userId: string) => Promise<number | null>;
  /** The row as it stands, or null when this is their first event. */
  loadExisting?: (userId: string) => Promise<ExistingSubscription | null>;
  /**
   * Record the event. Resolves `true` only for the call that inserted the row;
   * a conflict on the event id — i.e. a retry — resolves `false`.
   */
  recordEvent?: (row: {
    eventId: string;
    userId: string | null;
    type: string;
    eventTimeMs: number;
    payload: unknown;
    outcome: WebhookOutcome;
  }) => Promise<boolean>;
  writeSubscription?: (input: UpsertSubscriptionInput) => Promise<void>;
  /**
   * Move a subscription between accounts, ATOMICALLY.
   *
   * One dep rather than an expire + an upsert, because the two must not be
   * separable: a crash between them either funds two accounts from one purchase
   * or leaves nobody entitled, and both are worse than the event failing and
   * being retried. The default runs a real transaction; the test substitutes a
   * fake that can assert the pair moved together.
   */
  transferSubscription?: (input: {
    fromUserIds: string[];
    toUserId: string;
    at: Date;
  }) => Promise<{ movedFrom: string[] }>;
}

const defaultFindUserId: NonNullable<WebhookDeps['findUserId']> = async (appUserId) => {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, appUserId)).limit(1);
  return rows[0]?.id ?? null;
};

const defaultLastApplied: NonNullable<WebhookDeps['lastAppliedEventTimeMs']> = async (userId) => {
  const rows = await db
    .select({ eventTimeMs: subscriptionEvents.eventTimeMs })
    .from(subscriptionEvents)
    .where(and(eq(subscriptionEvents.userId, userId), eq(subscriptionEvents.outcome, 'applied')))
    .orderBy(desc(subscriptionEvents.eventTimeMs))
    .limit(1);
  return rows[0]?.eventTimeMs ?? null;
};

const defaultLoadExisting: NonNullable<WebhookDeps['loadExisting']> = async (userId) => {
  const rows = await db
    .select({
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      productId: subscriptions.productId,
      originalTransactionId: subscriptions.originalTransactionId,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * The move, in one transaction.
 *
 * WHAT IT CARRIES ACROSS, and why it is read from our own row rather than the
 * payload: a `TRANSFER` event carries `transferred_from` / `transferred_to` and
 * nothing else. No `product_id`, no `expiration_at_ms`, no
 * `original_transaction_id` — RevenueCat's field reference lists those under
 * the subscription-lifecycle events only. So the destination's row is built
 * from the ORIGIN's row, which is the one place those facts exist. Taking the
 * event at face value would hand the destination `currentPeriodEnd: null`,
 * which `resolveAccountState` reads as "no end" — an unlimited subscription,
 * granted by a transfer.
 *
 * The origin is EXPIRED rather than deleted: `subscriptions.userId` is the
 * primary key, one row per user, and the row is the only record that account
 * ever had access. `expired` is also exactly what the resolver needs to stop
 * entitling them, with no special case.
 */
const defaultTransferSubscription: NonNullable<WebhookDeps['transferSubscription']> = async ({
  fromUserIds,
  toUserId,
  at,
}) => {
  return db.transaction(async (tx) => {
    // Read the origin rows first: they hold the product, the period end and the
    // original transaction id that the event does not carry.
    const origins = fromUserIds.length
      ? await tx
          .select({
            userId: subscriptions.userId,
            status: subscriptions.status,
            productId: subscriptions.productId,
            currentPeriodEnd: subscriptions.currentPeriodEnd,
            originalTransactionId: subscriptions.originalTransactionId,
          })
          .from(subscriptions)
          .where(inArray(subscriptions.userId, fromUserIds))
      : [];

    // The best origin to inherit from: one that is actually live. A user who
    // was already expired tells us nothing useful about the term being moved.
    const source =
      origins.find((o) => o.status === 'active' || o.status === 'grace') ?? origins[0] ?? null;

    if (fromUserIds.length) {
      await tx
        .update(subscriptions)
        .set({ status: 'expired', autoRenew: false, updatedAt: at })
        .where(inArray(subscriptions.userId, fromUserIds));
    }

    await tx
      .insert(subscriptions)
      .values({
        userId: toUserId,
        status: 'active',
        source: 'apple_iap',
        productId: source?.productId ?? null,
        currentPeriodEnd: source?.currentPeriodEnd ?? null,
        originalTransactionId: source?.originalTransactionId ?? null,
        autoRenew: true,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: subscriptions.userId,
        set: {
          status: 'active',
          source: 'apple_iap',
          productId: source?.productId ?? null,
          currentPeriodEnd: source?.currentPeriodEnd ?? null,
          originalTransactionId: source?.originalTransactionId ?? null,
          autoRenew: true,
          // A transfer INTO a previously revoked account clears the revocation,
          // same reasoning as a new purchase: they hold the subscription now.
          revokedAt: null,
          revokedBy: null,
          revokedReason: null,
          updatedAt: at,
        },
      });

    return { movedFrom: origins.map((o) => o.userId) };
  });
};

const defaultRecordEvent: NonNullable<WebhookDeps['recordEvent']> = async (row) => {
  const inserted = await db
    .insert(subscriptionEvents)
    .values(row)
    .onConflictDoNothing({ target: subscriptionEvents.eventId })
    .returning({ id: subscriptionEvents.id });
  return inserted.length > 0;
};

/**
 * Apply one normalized event. Never throws for anything the store can send —
 * only for a database that is genuinely down, which the route turns into a 500
 * so RevenueCat retries something a retry can fix.
 *
 * The order below is load-bearing:
 *
 * 1. Resolve the user and read the last applied timestamp. Reads only.
 * 2. Decide (pure).
 * 3. **Record the event, with the decided outcome, BEFORE anything is
 *    written.** The insert conflicts on the event id, so a retry loses the
 *    race and returns `ignored_duplicate` having changed nothing. Apple and
 *    RevenueCat both retry; this is not a theoretical concern.
 * 4. Only then write the subscription.
 *
 * A crash between 3 and 4 records an event as applied that was not applied.
 * That is the cheaper failure: the alternative order double-applies on every
 * retry, and the store re-sends the subscriber's current state on the next
 * event anyway.
 */
export async function applySubscriptionEvent(
  event: NormalizedSubscriptionEvent,
  deps: WebhookDeps = {}
): Promise<WebhookResult> {
  const findUserId = deps.findUserId ?? defaultFindUserId;
  const lastApplied = deps.lastAppliedEventTimeMs ?? defaultLastApplied;
  const loadExisting = deps.loadExisting ?? defaultLoadExisting;
  const recordEvent = deps.recordEvent ?? defaultRecordEvent;
  const writeSubscription = deps.writeSubscription ?? upsertSubscription;

  const base = { eventId: event.eventId, type: event.type, eventTimeMs: event.eventTimeMs, payload: event.payload };

  /**
   * A transfer is resolved from `transferred_to`, never from `app_user_id`.
   *
   * That field is absent on this event — RevenueCat's reference lists only
   * `transferred_from` / `transferred_to` for it — and the docs' line about the
   * webhook being "sent for the destination user" describes delivery, not a
   * field to read. Assuming otherwise is how a transfer gets applied to the
   * account that just LOST the subscription.
   */
  if (event.type === TRANSFER) {
    return applyTransfer(event, base, {
      findUserId,
      lastApplied,
      recordEvent,
      transferSubscription: deps.transferSubscription ?? defaultTransferSubscription,
    });
  }

  // Non-transfer events always carry one; the schema refuses them otherwise.
  const userId = event.appUserId ? await findUserId(event.appUserId) : null;

  if (!userId) {
    // Recorded rather than dropped: if somebody's purchase is landing here
    // with no account behind it, the row is the only evidence of it. Still a
    // 200 at the route — retrying will not conjure the user.
    console.warn('[payments/webhook] event for unknown app_user_id', {
      eventId: event.eventId,
      type: event.type,
      appUserId: event.appUserId,
    });
    const recorded = await recordEvent({ ...base, userId: null, outcome: 'ignored_unknown_user' });
    return {
      outcome: recorded ? 'ignored_unknown_user' : 'ignored_duplicate',
      eventId: event.eventId,
      userId: null,
      status: null,
    };
  }

  const decision = decideFromEvent(event, await lastApplied(userId));

  if ('ignored' in decision) {
    if (decision.ignored === 'ignored_unknown_type') {
      // Logged, never fatal. A 500 here would have RevenueCat retrying a type
      // we are never going to handle, for as long as their backoff allows.
      console.warn('[payments/webhook] unhandled event type', {
        eventId: event.eventId,
        type: event.type,
      });
    }
    const recorded = await recordEvent({ ...base, userId, outcome: decision.ignored });
    return {
      outcome: recorded ? decision.ignored : 'ignored_duplicate',
      eventId: event.eventId,
      userId,
      status: null,
    };
  }

  // `transfer` cannot reach here — it returned above — but the union makes the
  // compiler ask, and answering it beats a cast.
  if (decision.action !== 'apply') {
    return { outcome: 'ignored_unknown_type', eventId: event.eventId, userId, status: null };
  }

  const recorded = await recordEvent({ ...base, userId, outcome: 'applied' });
  if (!recorded) {
    return { outcome: 'ignored_duplicate', eventId: event.eventId, userId, status: null };
  }

  const existing = await loadExisting(userId);

  await writeSubscription({
    userId,
    status: decision.status,
    source: 'apple_iap',
    productId: event.productId ?? existing?.productId ?? null,
    // A null `current_period_end` means "no end" to the resolver — an admin
    // comp or a lifetime promo. So an event that carries no expiry must leave
    // an existing one alone rather than write null and silently convert a
    // month of paid access into unlimited access.
    currentPeriodEnd: decision.periodEnd ?? existing?.currentPeriodEnd ?? null,
    originalTransactionId: event.originalTransactionId ?? existing?.originalTransactionId ?? null,
    autoRenew: decision.autoRenew,
  });

  return { outcome: 'applied', eventId: event.eventId, userId, status: decision.status };
}

/**
 * A subscription moving from one account to another.
 *
 * THE RULE, decided by the owner: the subscription follows the Apple ID. The
 * account that just restored it holds it, and the previous account loses access
 * immediately. There is one `subscriptions` row per user and one payment behind
 * it, so leaving the origin entitled would fund two accounts from one purchase.
 *
 * KNOWN CONSEQUENCE, ACCEPTED: the losing account is told nothing. Its next
 * gated request 402s with the ordinary "subscription ended" copy, which is close
 * enough to true, and this event is rare.
 *
 * ── Why the destination is resolved before anything is written ──
 *
 * If we cannot find the destination user, NOTHING changes — not even the
 * origin's row. The alternative reads well ("the subscription has gone, expire
 * them") and is wrong: an unknown destination means the purchase left our system
 * entirely, most likely onto an anonymous RevenueCat id, and expiring the origin
 * would strand somebody who is still paying with nobody to hand their access to.
 * The event is recorded as `ignored_unknown_user`, which is the outcome that
 * exists to be findable in the admin log.
 *
 * ── Two event rows ──
 *
 * `subscription_events.event_id` is UNIQUE, so the origin's row is written under
 * a suffixed id. Both carry the verbatim payload, so the move is reconstructable
 * afterwards from either side — which matters precisely because the losing user
 * is never told, and a support question about it arrives with no other trail.
 */
async function applyTransfer(
  event: NormalizedSubscriptionEvent,
  base: { eventId: string; type: string; eventTimeMs: number; payload: unknown },
  deps: {
    findUserId: NonNullable<WebhookDeps['findUserId']>;
    lastApplied: NonNullable<WebhookDeps['lastAppliedEventTimeMs']>;
    recordEvent: NonNullable<WebhookDeps['recordEvent']>;
    transferSubscription: NonNullable<WebhookDeps['transferSubscription']>;
  }
): Promise<WebhookResult> {
  // Destination first. `transferred_to` is an array because one Apple ID's
  // purchases can land on more than one app user id; the first we recognise is
  // the one that gets it, and any others are not accounts we have.
  const toIds = await Promise.all(event.transferredTo.map((id) => deps.findUserId(id)));
  const toUserId = toIds.find((id): id is string => id !== null) ?? null;

  if (!toUserId) {
    console.warn('[payments/webhook] TRANSFER to an unknown destination', {
      eventId: event.eventId,
      transferredTo: event.transferredTo,
    });
    const recorded = await deps.recordEvent({ ...base, userId: null, outcome: 'ignored_unknown_user' });
    return {
      outcome: recorded ? 'ignored_unknown_user' : 'ignored_duplicate',
      eventId: event.eventId,
      userId: null,
      status: null,
    };
  }

  const decision = decideFromEvent(event, await deps.lastApplied(toUserId));
  if ('ignored' in decision) {
    const recorded = await deps.recordEvent({ ...base, userId: toUserId, outcome: decision.ignored });
    return {
      outcome: recorded ? decision.ignored : 'ignored_duplicate',
      eventId: event.eventId,
      userId: toUserId,
      status: null,
    };
  }

  // Record BEFORE writing, the same order the rest of this handler keeps: the
  // insert conflicts on the event id, so a retry loses the race and changes
  // nothing rather than moving a subscription twice.
  const recorded = await deps.recordEvent({ ...base, userId: toUserId, outcome: 'applied' });
  if (!recorded) {
    return { outcome: 'ignored_duplicate', eventId: event.eventId, userId: toUserId, status: null };
  }

  const fromIds = await Promise.all(event.transferredFrom.map((id) => deps.findUserId(id)));
  const fromUserIds = fromIds.filter(
    (id): id is string => id !== null && id !== toUserId
  );

  const { movedFrom } = await deps.transferSubscription({
    fromUserIds,
    toUserId,
    at: new Date(),
  });

  // The origin's own row in the ledger. Suffixed because the event id is unique
  // and the destination already used it; `onConflictDoNothing` keeps a retry
  // harmless. Best-effort: the subscriptions have already moved correctly, and
  // failing the whole event to retry a log line would re-run the move.
  for (const fromUserId of movedFrom) {
    await deps
      .recordEvent({
        ...base,
        eventId: `${event.eventId}:from:${fromUserId}`,
        userId: fromUserId,
        outcome: 'applied',
      })
      .catch(() => false);
  }

  return { outcome: 'applied', eventId: event.eventId, userId: toUserId, status: 'active' };
}
