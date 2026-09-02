import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `server-only` throws outside a React Server Component; the DB client is
// mocked because nothing here should touch Postgres. Both hoisted above the
// imports, same as oauthReplay.test.ts.
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ db: {}, schema: {} }));

const { applyMock } = vi.hoisted(() => ({ applyMock: vi.fn() }));
vi.mock('@/server/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/payments')>();
  return { ...actual, applySubscriptionEvent: applyMock };
});

import { POST } from '@/app/api/webhooks/revenuecat/route';
import type { UpsertSubscriptionInput } from './entitlements';
import { normalizeWebhookEvent, revenueCatWebhookSchema } from './schemas';
import {
  applySubscriptionEvent,
  decideFromEvent,
  isKnownEventType,
  type ExistingSubscription,
  type WebhookDeps,
  type WebhookOutcome,
} from './webhook';

/**
 * Why this file is mostly pure-function tests plus a small in-memory world,
 * and not a mocked drizzle:
 *
 * Everything worth pinning here is a RULE (which notification means which
 * state) or an ORDER (record before write, so a retry changes nothing). A
 * hand-mocked query builder would assert that we called drizzle the way we
 * called drizzle — it would go green on a handler that recorded the event
 * after writing the subscription, which is the exact bug the ordering exists
 * to prevent. So `decideFromEvent` is tested exhaustively with no I/O at all,
 * and `applySubscriptionEvent` runs against a fake store whose `recordEvent`
 * enforces the same uniqueness the `subscription_events` unique index does.
 * `states.ts` and `oauthReplay.ts` are both built this way for the same reason.
 *
 * The one thing a fake cannot prove is that the ON CONFLICT target really is
 * the event id. That is asserted by the unique index in migration 0026 and by
 * the shape of `defaultRecordEvent`.
 */

const USER_ID = 'usr_7f3c1a90';
const MONTHLY = 'com.feraltravels.app.monthly';

/** A real RevenueCat body, trimmed of the fields we never read but left messy. */
function rcBody(over: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      aliases: [USER_ID],
      app_id: 'app1a2b3c',
      app_user_id: USER_ID,
      commission_percentage: 0.15,
      country_code: 'GB',
      currency: 'USD',
      entitlement_ids: ['pro'],
      environment: 'PRODUCTION',
      event_timestamp_ms: 1_756_000_000_000,
      expiration_at_ms: 1_758_592_000_000,
      id: 'evt_0001',
      is_family_share: false,
      original_app_user_id: USER_ID,
      original_transaction_id: '2000000891234567',
      period_type: 'NORMAL',
      price: 2,
      price_in_purchased_currency: 2,
      product_id: MONTHLY,
      purchased_at_ms: 1_756_000_000_000,
      store: 'APP_STORE',
      takehome_percentage: 0.85,
      transaction_id: '2000000891234567',
      type: 'INITIAL_PURCHASE',
      ...over,
    },
  };
}

function event(over: Record<string, unknown> = {}, receivedAtMs = 1_756_000_000_000) {
  return normalizeWebhookEvent(revenueCatWebhookSchema.parse(rcBody(over)), receivedAtMs);
}

describe('revenueCatWebhookSchema', () => {
  it('parses a full production payload and normalizes the fields we act on', () => {
    const e = event();
    expect(e).toMatchObject({
      eventId: 'evt_0001',
      type: 'INITIAL_PURCHASE',
      appUserId: USER_ID,
      productId: MONTHLY,
      periodEndMs: 1_758_592_000_000,
      eventTimeMs: 1_756_000_000_000,
      store: 'APP_STORE',
      originalTransactionId: '2000000891234567',
    });
  });

  it('keeps the verbatim body on the event, unknown fields included', () => {
    const e = event({ some_field_added_next_year: { nested: true } });
    expect(e.payload).toMatchObject({
      event: { some_field_added_next_year: { nested: true } },
    });
  });

  it('accepts a notification type it has never heard of', () => {
    // A 400 here would make RevenueCat retry forever something we were never
    // going to act on. Unknown types must PARSE, then be ignored by the handler.
    expect(() => revenueCatWebhookSchema.parse(rcBody({ type: 'SUBSCRIPTION_PAUSED' }))).not.toThrow();
  });

  it('rejects a body missing the three fields that make an event actionable', () => {
    for (const missing of ['id', 'type', 'app_user_id']) {
      const body = rcBody();
      delete (body.event as Record<string, unknown>)[missing];
      expect(() => revenueCatWebhookSchema.parse(body), missing).toThrow();
    }
  });

  it('falls back to purchased_at_ms, then to arrival, for the ordering clock', () => {
    expect(event({ event_timestamp_ms: null }).eventTimeMs).toBe(1_756_000_000_000);
    expect(
      event({ event_timestamp_ms: null, purchased_at_ms: null }, 1_799_000_000_000).eventTimeMs
    ).toBe(1_799_000_000_000);
  });

  it('reports a missing expiry as null rather than inventing one', () => {
    expect(event({ expiration_at_ms: null }).periodEndMs).toBeNull();
  });
});

describe('decideFromEvent — type to state', () => {
  const cases: Array<[string, string, boolean]> = [
    ['INITIAL_PURCHASE', 'active', true],
    ['RENEWAL', 'active', true],
    ['PRODUCT_CHANGE', 'active', true],
    ['UNCANCELLATION', 'active', true],
    ['CANCELLATION', 'active', false],
    ['EXPIRATION', 'expired', false],
    ['BILLING_ISSUE', 'grace', true],
    ['REFUND', 'refunded', false],
  ];

  it.each(cases)('%s → status %s, autoRenew %s', (type, status, autoRenew) => {
    const d = decideFromEvent(event({ type }), null);
    expect(d).toEqual({
      action: 'apply',
      status,
      autoRenew,
      periodEnd: new Date(1_758_592_000_000),
    });
  });

  it('CANCELLATION does NOT expire the subscription', () => {
    // The regression this whole mapping exists to prevent. Cancelling turns
    // off auto-renew; the user has already paid through the period end and
    // cancelling returns no money. Writing `expired` here would take the cash
    // and withhold the product — see docs/design/subscriptions.md.
    const d = decideFromEvent(event({ type: 'CANCELLATION' }), null);
    expect(d).toMatchObject({ status: 'active', autoRenew: false });
    expect(d).not.toMatchObject({ status: 'expired' });
  });

  it('carries the expiry through as the period end', () => {
    const d = decideFromEvent(event({ expiration_at_ms: 1_760_000_000_000 }), null);
    expect(d).toMatchObject({ periodEnd: new Date(1_760_000_000_000) });
  });

  it('leaves the period end null when the event has no expiry', () => {
    expect(decideFromEvent(event({ expiration_at_ms: null }), null)).toMatchObject({
      periodEnd: null,
    });
  });

  it('ignores a type it does not handle', () => {
    // TRANSFER used to be on this list and is now handled — see the transfer
    // describe block below. Everything here is still genuinely unhandled.
    for (const type of ['SUBSCRIPTION_PAUSED', 'TEST', 'SOMETHING_NEW']) {
      expect(decideFromEvent(event({ type }), null), type).toEqual({
        ignored: 'ignored_unknown_type',
      });
    }
  });
});

describe('decideFromEvent — out-of-order delivery', () => {
  const REFUND_AT = 1_756_000_000_000;

  it('refuses a RENEWAL older than the last applied event', () => {
    // The scenario: REFUND applied, then a RENEWAL that was delayed in flight
    // lands afterwards. Applying it would hand back access Apple has already
    // refunded the money for.
    const stale = event({ type: 'RENEWAL', event_timestamp_ms: REFUND_AT - 60_000 });
    expect(decideFromEvent(stale, REFUND_AT)).toEqual({ ignored: 'ignored_stale' });
  });

  it('applies an event newer than the last applied one', () => {
    const fresh = event({ type: 'RENEWAL', event_timestamp_ms: REFUND_AT + 1 });
    expect(decideFromEvent(fresh, REFUND_AT)).toMatchObject({ action: 'apply', status: 'active' });
  });

  it('treats an equal timestamp as current, not stale', () => {
    // Two distinct events can share a millisecond; dropping the second would
    // lose a real state change.
    const same = event({ type: 'CANCELLATION', event_timestamp_ms: REFUND_AT });
    expect(same.eventTimeMs).toBe(REFUND_AT);
    expect(decideFromEvent(same, REFUND_AT)).toMatchObject({ action: 'apply' });
  });

  it('applies everything when nothing has been applied yet', () => {
    expect(decideFromEvent(event({ event_timestamp_ms: 1 }), null)).toMatchObject({
      action: 'apply',
    });
  });

  it('reports an unknown type as unknown even when it is also stale', () => {
    // Type is decided first on purpose: an event we do not understand tells us
    // nothing about ordering either, and the recorded outcome stays a function
    // of the type alone so the admin log reads consistently.
    const stale = event({ type: 'SUBSCRIPTION_PAUSED', event_timestamp_ms: REFUND_AT - 60_000 });
    expect(decideFromEvent(stale, REFUND_AT)).toEqual({ ignored: 'ignored_unknown_type' });
  });
});

interface RecordedEvent {
  eventId: string;
  userId: string | null;
  type: string;
  eventTimeMs: number;
  outcome: WebhookOutcome;
}

/**
 * An in-memory stand-in for the two tables, with the constraint that matters:
 * `recordEvent` refuses a duplicate event id, exactly as the unique index on
 * `subscription_events.event_id` does.
 */
function fakeWorld(opts: { knownUsers?: string[]; existing?: ExistingSubscription | null } = {}) {
  const known = new Set(opts.knownUsers ?? [USER_ID]);
  const events: RecordedEvent[] = [];
  const writes: UpsertSubscriptionInput[] = [];
  let existing: ExistingSubscription | null = opts.existing ?? null;

  const deps: WebhookDeps = {
    findUserId: async (appUserId) => (known.has(appUserId) ? appUserId : null),
    lastAppliedEventTimeMs: async (userId) => {
      const applied = events.filter((e) => e.userId === userId && e.outcome === 'applied');
      return applied.length ? Math.max(...applied.map((e) => e.eventTimeMs)) : null;
    },
    loadExisting: async () => existing,
    recordEvent: async (row) => {
      if (events.some((e) => e.eventId === row.eventId)) return false;
      events.push({
        eventId: row.eventId,
        userId: row.userId,
        type: row.type,
        eventTimeMs: row.eventTimeMs,
        outcome: row.outcome,
      });
      return true;
    },
    writeSubscription: async (input) => {
      writes.push(input);
      existing = {
        currentPeriodEnd: input.currentPeriodEnd ?? null,
        productId: input.productId ?? null,
        originalTransactionId: input.originalTransactionId ?? null,
      };
    },
  };

  const transfers: Array<{ fromUserIds: string[]; toUserId: string }> = [];
  deps.transferSubscription = async ({ fromUserIds, toUserId }) => {
    transfers.push({ fromUserIds, toUserId });
    return { movedFrom: fromUserIds };
  };

  return { deps, events, writes, transfers, get existing() { return existing; } };
}

describe('applySubscriptionEvent', () => {
  it('applies a purchase and writes the row through the apple_iap source', async () => {
    const w = fakeWorld();
    const result = await applySubscriptionEvent(event(), w.deps);

    expect(result).toEqual({
      outcome: 'applied',
      eventId: 'evt_0001',
      userId: USER_ID,
      status: 'active',
    });
    expect(w.writes).toEqual([
      {
        userId: USER_ID,
        status: 'active',
        source: 'apple_iap',
        productId: MONTHLY,
        currentPeriodEnd: new Date(1_758_592_000_000),
        originalTransactionId: '2000000891234567',
        autoRenew: true,
      },
    ]);
    expect(w.events).toHaveLength(1);
    expect(w.events[0].outcome).toBe('applied');
  });

  it('is idempotent: the same event id twice changes nothing', async () => {
    // Both Apple and RevenueCat retry. This happens in production, not in
    // theory — a redelivered REFUND must not write a second time.
    const w = fakeWorld();
    const first = await applySubscriptionEvent(event({ type: 'REFUND' }), w.deps);
    const second = await applySubscriptionEvent(event({ type: 'REFUND' }), w.deps);

    expect(first.outcome).toBe('applied');
    expect(second).toEqual({
      outcome: 'ignored_duplicate',
      eventId: 'evt_0001',
      userId: USER_ID,
      status: null,
    });
    expect(w.writes).toHaveLength(1);
    expect(w.events).toHaveLength(1);
  });

  it('records the event BEFORE it writes the subscription', async () => {
    // Ordering, not bookkeeping: if the write went first, a retry arriving
    // while the first delivery was still in flight would double-apply. The
    // claim on the event id has to be what loses the race.
    const order: string[] = [];
    const w = fakeWorld();
    const deps: WebhookDeps = {
      ...w.deps,
      recordEvent: async (row) => {
        order.push('record');
        return w.deps.recordEvent!(row);
      },
      writeSubscription: async (input) => {
        order.push('write');
        return w.deps.writeSubscription!(input);
      },
    };
    await applySubscriptionEvent(event(), deps);
    expect(order).toEqual(['record', 'write']);
  });

  it('does not let a stale RENEWAL resurrect access after a REFUND', async () => {
    const w = fakeWorld();
    await applySubscriptionEvent(
      event({ id: 'evt_refund', type: 'REFUND', event_timestamp_ms: 1_756_000_000_000 }),
      w.deps
    );
    const late = await applySubscriptionEvent(
      event({ id: 'evt_renewal', type: 'RENEWAL', event_timestamp_ms: 1_755_000_000_000 }),
      w.deps
    );

    expect(late.outcome).toBe('ignored_stale');
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0].status).toBe('refunded');
    // Still recorded, so the admin log shows the late delivery arrived.
    expect(w.events.map((e) => e.outcome)).toEqual(['applied', 'ignored_stale']);
  });

  it('records an unknown type and touches nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = fakeWorld();
    const result = await applySubscriptionEvent(event({ type: 'SUBSCRIPTION_PAUSED' }), w.deps);

    expect(result.outcome).toBe('ignored_unknown_type');
    expect(result.userId).toBe(USER_ID);
    expect(w.writes).toHaveLength(0);
    expect(w.events[0]).toMatchObject({
      type: 'SUBSCRIPTION_PAUSED',
      outcome: 'ignored_unknown_type',
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('records an event for a user we do not have, with a null user id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = fakeWorld({ knownUsers: [] });
    const result = await applySubscriptionEvent(event(), w.deps);

    expect(result).toEqual({
      outcome: 'ignored_unknown_user',
      eventId: 'evt_0001',
      userId: null,
      status: null,
    });
    // Kept rather than dropped: if a purchase is landing here with no account
    // behind it, this row is the only evidence of it.
    expect(w.events[0]).toMatchObject({ userId: null, outcome: 'ignored_unknown_user' });
    expect(w.writes).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never resurrects a refunded account by re-applying the same refund', async () => {
    const w = fakeWorld();
    await applySubscriptionEvent(event({ id: 'a', type: 'INITIAL_PURCHASE' }), w.deps);
    await applySubscriptionEvent(
      event({ id: 'b', type: 'REFUND', event_timestamp_ms: 1_756_100_000_000 }),
      w.deps
    );
    await applySubscriptionEvent(
      event({ id: 'b', type: 'REFUND', event_timestamp_ms: 1_756_100_000_000 }),
      w.deps
    );

    expect(w.writes.map((x) => x.status)).toEqual(['active', 'refunded']);
  });

  it('keeps an existing period end when the event carries no expiry', async () => {
    // A null `current_period_end` reads as "no end" — an admin comp or a
    // lifetime promo. An event without an expiry must not turn a month of
    // paid access into unlimited access.
    const periodEnd = new Date(1_758_592_000_000);
    const w = fakeWorld({
      existing: { currentPeriodEnd: periodEnd, productId: MONTHLY, originalTransactionId: 'tx1' },
    });
    await applySubscriptionEvent(
      event({ type: 'BILLING_ISSUE', expiration_at_ms: null, product_id: null }),
      w.deps
    );

    expect(w.writes[0]).toMatchObject({
      status: 'grace',
      currentPeriodEnd: periodEnd,
      productId: MONTHLY,
    });
  });

  it('lets a cancelled subscriber keep the term they paid for', async () => {
    const w = fakeWorld();
    await applySubscriptionEvent(event({ id: 'p', type: 'INITIAL_PURCHASE' }), w.deps);
    await applySubscriptionEvent(
      event({ id: 'c', type: 'CANCELLATION', event_timestamp_ms: 1_756_100_000_000 }),
      w.deps
    );

    const after = w.writes[1];
    expect(after.status).toBe('active');
    expect(after.autoRenew).toBe(false);
    expect(after.currentPeriodEnd).toEqual(new Date(1_758_592_000_000));
  });
});

describe('POST /api/webhooks/revenuecat', () => {
  const SECRET = 'rc_whsec_9f2b41c8d0e7';

  function post(headers: Record<string, string>, body: unknown = rcBody()) {
    return POST(
      new Request('https://feraltravels.com/api/webhooks/revenuecat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    );
  }

  beforeEach(() => {
    process.env.REVENUECAT_WEBHOOK_SECRET = SECRET;
    applyMock.mockReset();
    applyMock.mockResolvedValue({
      outcome: 'applied',
      eventId: 'evt_0001',
      userId: USER_ID,
      status: 'active',
    });
  });

  afterEach(() => {
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    vi.restoreAllMocks();
  });

  it('refuses everything with 503 when the secret is not configured', async () => {
    // Never default-open. An unset variable is an unfinished deploy, and 503
    // is retryable, so events queued during the gap arrive once it is set.
    delete process.env.REVENUECAT_WEBHOOK_SECRET;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ authorization: SECRET });
    expect(res.status).toBe(503);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('rejects a missing Authorization header', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post({});
    expect(res.status).toBe(401);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret, including one of the right length', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sameLength = 'rc_whsec_9f2b41c8d0e8';
    expect(sameLength).toHaveLength(SECRET.length);
    expect((await post({ authorization: sameLength })).status).toBe(401);
    expect((await post({ authorization: 'nope' })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${SECRET}` })).status).toBe(401);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('accepts the configured secret and hands the event to the handler', async () => {
    const res = await post({ authorization: SECRET });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, outcome: 'applied' });
    expect(applyMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_0001', type: 'INITIAL_PURCHASE', appUserId: USER_ID })
    );
  });

  it('answers 200 for an event it deliberately ignores', async () => {
    // A 500 would have RevenueCat retrying a notification we are never going
    // to handle, for as long as their backoff allows.
    applyMock.mockResolvedValue({
      outcome: 'ignored_unknown_type',
      eventId: 'evt_0001',
      userId: USER_ID,
      status: null,
    });
    const res = await post({ authorization: SECRET }, rcBody({ type: 'SUBSCRIPTION_PAUSED' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, outcome: 'ignored_unknown_type' });
  });

  it('rejects a body that is not a RevenueCat webhook', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await post({ authorization: SECRET }, { hello: 'world' })).status).toBe(400);
    expect((await post({ authorization: SECRET }, 'not json')).status).toBe(400);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('returns 500 when applying throws, so the retry is not wasted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    applyMock.mockRejectedValue(new Error('connection terminated'));
    const res = await post({ authorization: SECRET });
    expect(res.status).toBe(500);
  });
});

/**
 * TRANSFER — a subscription moving between two of our accounts.
 *
 * The rule: it follows the Apple ID. The account that just restored it holds
 * it, the previous one loses access immediately. One row per user and one
 * payment behind it, so leaving the origin entitled would fund two accounts
 * from one purchase.
 *
 * The reason these tests are worth their length is that this event does not
 * look like any other one. It carries NO `app_user_id`, no `product_id`, no
 * `expiration_at_ms` and no `original_transaction_id` — only
 * `transferred_from` and `transferred_to`. Every assumption the other eight
 * types let you make is wrong here.
 */
describe('applySubscriptionEvent — TRANSFER', () => {
  const OLD_USER = 'usr_old_1111';
  const NEW_USER = 'usr_new_2222';

  /** A transfer body, shaped the way RevenueCat actually sends one. */
  function transferBody(over: Record<string, unknown> = {}) {
    return {
      api_version: '1.0',
      event: {
        id: 'evt_transfer_1',
        type: 'TRANSFER',
        // NO app_user_id. This is not an omission in the fixture — the event
        // does not have one, and the schema had to be taught that.
        transferred_from: [OLD_USER],
        transferred_to: [NEW_USER],
        event_timestamp_ms: 1_756_000_000_000,
        store: 'APP_STORE',
        environment: 'PRODUCTION',
        ...over,
      },
    };
  }

  const transferEvent = (over: Record<string, unknown> = {}) =>
    normalizeWebhookEvent(revenueCatWebhookSchema.parse(transferBody(over)));

  it('PARSES, despite carrying no app_user_id', () => {
    // The regression that would otherwise have 400'd every real transfer at the
    // boundary, with RevenueCat retrying each one for as long as its backoff
    // allowed. `app_user_id` is required for every other type and refused here.
    expect(() => revenueCatWebhookSchema.parse(transferBody())).not.toThrow();
    const e = transferEvent();
    expect(e.appUserId).toBeNull();
    expect(e.transferredFrom).toEqual([OLD_USER]);
    expect(e.transferredTo).toEqual([NEW_USER]);
  });

  it('still refuses a non-transfer event with no app_user_id', () => {
    // The strictness the nullish field gives up, taken back everywhere else.
    expect(() =>
      revenueCatWebhookSchema.parse({
        event: { id: 'e', type: 'RENEWAL', event_timestamp_ms: 1 },
      })
    ).toThrow();
  });

  it('refuses a TRANSFER that names no destination', () => {
    expect(() => revenueCatWebhookSchema.parse(transferBody({ transferred_to: [] }))).toThrow();
  });

  it('gives the subscription to transferred_to and takes it from transferred_from', async () => {
    const w = fakeWorld({ knownUsers: [OLD_USER, NEW_USER] });
    const result = await applySubscriptionEvent(transferEvent(), w.deps);

    expect(result).toEqual({
      outcome: 'applied',
      eventId: 'evt_transfer_1',
      userId: NEW_USER,
      status: 'active',
    });
    expect(w.transfers).toEqual([{ fromUserIds: [OLD_USER], toUserId: NEW_USER }]);
  });

  it('does NOT read the destination from app_user_id — the trap in this event', async () => {
    /**
     * If a body ever does carry `app_user_id`, it is not a promise about which
     * side of the move it names. Here it is deliberately set to the LOSING
     * account: an implementation that used it would grant the subscription to
     * the user who just lost it and expire the one who just restored it — the
     * exact inverse of the rule, and entirely silent.
     */
    const w = fakeWorld({ knownUsers: [OLD_USER, NEW_USER] });
    await applySubscriptionEvent(transferEvent({ app_user_id: OLD_USER }), w.deps);

    expect(w.transfers).toEqual([{ fromUserIds: [OLD_USER], toUserId: NEW_USER }]);
  });

  it('writes a ledger row for BOTH sides, under distinct event ids', async () => {
    // `subscription_events.event_id` is unique, so the origin's row is
    // suffixed. Both exist because the losing user is never told anything, and
    // a support question about it arrives with no other trail.
    const w = fakeWorld({ knownUsers: [OLD_USER, NEW_USER] });
    await applySubscriptionEvent(transferEvent(), w.deps);

    expect(w.events).toHaveLength(2);
    expect(w.events.map((e) => e.userId).sort()).toEqual([NEW_USER, OLD_USER].sort());
    expect(new Set(w.events.map((e) => e.eventId)).size).toBe(2);
    for (const e of w.events) expect(e.outcome).toBe('applied');
  });

  it('changes NOTHING when the destination is unknown to us', async () => {
    /**
     * Reads well as "the subscription has gone, expire them" and is wrong: an
     * unknown destination means the purchase left our system — most likely onto
     * an anonymous RevenueCat id — and expiring the origin would strand
     * somebody still paying with nobody to hand their access to.
     */
    const w = fakeWorld({ knownUsers: [OLD_USER] });
    const result = await applySubscriptionEvent(transferEvent(), w.deps);

    expect(result.outcome).toBe('ignored_unknown_user');
    expect(w.transfers).toEqual([]);
    expect(w.events).toHaveLength(1);
    expect(w.events[0].userId).toBeNull();
  });

  it('never expires the destination, even if it names itself as an origin', async () => {
    // A self-transfer is not a way to lose your own subscription.
    const w = fakeWorld({ knownUsers: [NEW_USER] });
    await applySubscriptionEvent(
      transferEvent({ transferred_from: [NEW_USER], transferred_to: [NEW_USER] }),
      w.deps
    );
    expect(w.transfers).toEqual([{ fromUserIds: [], toUserId: NEW_USER }]);
  });

  it('is idempotent — a retry moves nothing a second time', async () => {
    const w = fakeWorld({ knownUsers: [OLD_USER, NEW_USER] });
    await applySubscriptionEvent(transferEvent(), w.deps);
    const replay = await applySubscriptionEvent(transferEvent(), w.deps);

    expect(replay.outcome).toBe('ignored_duplicate');
    expect(w.transfers).toHaveLength(1);
  });

  it('refuses a transfer that lands after a newer event for that user', async () => {
    // Delivery order is not event order, and the same rule the other types get.
    const w = fakeWorld({ knownUsers: [OLD_USER, NEW_USER] });
    await applySubscriptionEvent(
      event({ id: 'evt_refund', type: 'REFUND', app_user_id: NEW_USER, event_timestamp_ms: 1_757_000_000_000 }),
      w.deps
    );
    const result = await applySubscriptionEvent(
      transferEvent({ event_timestamp_ms: 1_756_000_000_000 }),
      w.deps
    );

    expect(result.outcome).toBe('ignored_stale');
    expect(w.transfers).toEqual([]);
  });

  it('is a known type, so it is never logged as unhandled', () => {
    expect(isKnownEventType('TRANSFER')).toBe(true);
  });
});
