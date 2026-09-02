/**
 * The account-state machine, as a PURE function.
 *
 * No imports from the database, no `server-only`, no clock of its own — every
 * input arrives in `AccountFacts`. That is the point: the twelve states in
 * docs/design/subscriptions.md each need a test, and a resolver that reads the
 * DB can only be tested by writing rows for a moment in time. This one is
 * tested by describing a moment.
 *
 * `entitlements.ts` is the thin layer that fetches the facts and calls this.
 */

import {
  STOP_MICROCENTS,
  TRIAL_CEILING_MICROCENTS,
  TRIAL_DAYS,
  WATCH_MICROCENTS,
} from './constants';
import type {
  AccountState,
  BlockReason,
  SubscriptionSource,
  SubscriptionStatus,
} from '@/types/entitlement';

export type { AccountState, BlockReason };

export interface SubscriptionFacts {
  status: SubscriptionStatus;
  /** Null means no end date — an admin grant or a lifetime promo. */
  currentPeriodEnd: Date | null;
  autoRenew: boolean;
  /**
   * Where the entitlement came from — `apple_iap`, `promo`, `admin`, `fake`.
   *
   * Display only, like `productId`. It is what lets Settings call a promo an
   * Ambassador plan instead of guessing a product name it does not have: a
   * promo row carries no `productId` by design, so without `source` the only
   * honest thing to say was "Subscribed".
   *
   * NOT to be read by the rules. A promo subscriber is a subscriber; the whole
   * point of writing an ordinary row is that `resolveAccountState` never learns
   * about promo codes.
   */
  source?: SubscriptionSource | null;
  /**
   * The store product id, e.g. `com.feraltravels.app.annual`.
   *
   * Optional because nothing about ENTITLEMENT depends on it — the resolver
   * below never reads it, and it must not start to. It is carried so Settings
   * can say *which* plan you are on instead of a bare "Subscribed"; the mapping
   * from id to a human word happens once, at the API boundary, via `PRODUCTS`.
   */
  productId?: string | null;
}

export interface AccountFacts {
  now: Date;
  createdAt: Date;
  comped: boolean;
  /** Anthropic-only spend over the rolling 12-month window, in microcents. */
  anthropicMicrocents12mo: number;
  subscription: SubscriptionFacts | null;
}

export interface AccountVerdict {
  state: AccountState;
  /** May this account spend money — new trips, replans, any Penny turn? */
  entitled: boolean;
  /** May this account still READ trips it already made? False only on refund/revoke. */
  canViewExistingTrips: boolean;
  blockReason: BlockReason | null;
  /** When the free trial runs out. Null once they are past it or subscribed. */
  trialEndsAt: Date | null;
  /** Crossed thresholds, for the alert layer. Computed even for entitled users. */
  crossedWatch: boolean;
  crossedStop: boolean;
  /**
   * Whether the paywall is switched ON in this environment. False means the
   * state below is real and simply not being enforced — `entitled` will be
   * true regardless. See `switch.ts`.
   */
  enforced: boolean;
  /**
   * The 12-month Anthropic figure the verdict was decided on, passed straight
   * back out. The alert email reports it, and a caller that re-queried for it
   * could report a number the decision was never made on.
   */
  spendMicrocents: number;
  /**
   * The three subscription facts, passed straight through for DISPLAY.
   *
   * None of them changes any decision this resolver makes — `state`,
   * `entitled` and `blockReason` are computed exactly as before and a reader
   * should not have to wonder whether adding these moved anything. They are
   * here because `GET /api/me/entitlement` had no way to tell the app which
   * plan was bought or when the period ends, so Settings could only say
   * "Subscribed", and the data was on the row the whole time.
   *
   * `autoRenew` defaults to FALSE with no subscription, not true: "no row"
   * means nothing is renewing.
   */
  productId: string | null;
  currentPeriodEnd: Date | null;
  autoRenew: boolean;
  source: SubscriptionSource | null;
}

export function trialEndsAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

const ENTITLED: AccountState[] = [
  'trial',
  'subscribed',
  'subscribed_watch',
  'cancelled_in_period',
  'billing_grace',
  'comped',
];

export function resolveAccountState(facts: AccountFacts): AccountVerdict {
  const { now, createdAt, comped, anthropicMicrocents12mo: spend, subscription: sub } = facts;

  const crossedWatch = spend >= WATCH_MICROCENTS;
  const crossedStop = spend >= STOP_MICROCENTS;

  const verdict = (
    state: AccountState,
    blockReason: BlockReason | null,
    opts: { canView?: boolean; trialEndsAt?: Date | null } = {}
  ): AccountVerdict => ({
    state,
    entitled: ENTITLED.includes(state),
    canViewExistingTrips: opts.canView ?? true,
    blockReason,
    trialEndsAt: opts.trialEndsAt ?? null,
    crossedWatch,
    crossedStop,
    spendMicrocents: spend,
    // Display-only passthrough. See the note on AccountVerdict: these are read
    // off the row, never consulted by the rules above.
    productId: sub?.productId ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    autoRenew: sub?.autoRenew ?? false,
    source: sub?.source ?? null,
    // The pure resolver always reports the true, enforced verdict. The switch
    // is applied one layer up, in `entitlements.ts`, so these tests keep
    // describing what the rules SAY rather than what an env var permits.
    enforced: true,
  });

  // Comped wins over everything, INCLUDING the usage cap. The author's account
  // and the E2E fixtures must never be blocked by their own spend — CI would
  // start failing on a threshold that exists to protect revenue these accounts
  // do not generate.
  if (comped) return verdict('comped', null);

  if (sub) {
    // Money already returned, or an admin pulled the plug. Closed completely:
    // this is the one case where existing trips also stop being readable.
    if (sub.status === 'refunded') return verdict('refunded', 'revoked', { canView: false });
    if (sub.status === 'revoked') return verdict('revoked', 'revoked', { canView: false });

    const periodOver =
      sub.currentPeriodEnd !== null && now.getTime() >= sub.currentPeriodEnd.getTime();

    if (sub.status === 'expired' || periodOver) {
      // A row still marked active whose period has passed means the renewal
      // webhook has not arrived (or never will). Treat the clock as the
      // authority, not the stale status — the alternative is free access for
      // as long as a webhook is missing.
      return verdict('expired', 'subscription_over');
    }

    // ORDER MATTERS BELOW, and it was wrong the first time it was written.
    //
    // The cap is checked FIRST, ahead of cancellation and grace, because it is
    // the only rule here that blocks. Checking cancellation first meant a user
    // who cancelled an annual plan on day 3 kept 362 uncapped days — the exact
    // account the $8.50 ceiling exists to bound, since they will never renew
    // and the revenue is already banked. Cancelling still does not END access;
    // it just does not exempt them from the cap that every other subscriber is
    // under.
    if (crossedStop) return verdict('subscribed_capped', 'usage_cap');

    // Cancelled means auto-renew is OFF, not that access ends. They paid
    // through `currentPeriodEnd` and cancelling returns no money; ending it
    // early would be keeping the cash and withholding the product.
    if (sub.status === 'cancelled' || sub.autoRenew === false) {
      return verdict('cancelled_in_period', null);
    }

    // Grace before watch. Both are entitled, so nothing about ACCESS turns on
    // the order — but `billing_grace` is the state that renders the "update
    // your payment method" banner, and watch is invisible by design. Checking
    // watch first silently swallowed the banner for any grace user who also
    // happened to be over $2.
    if (sub.status === 'grace') return verdict('billing_grace', null);
    if (crossedWatch) return verdict('subscribed_watch', null);
    return verdict('subscribed', null);
  }

  // No subscription row: the trial is the only thing that can entitle them.
  const endsAt = trialEndsAt(createdAt);
  if (now.getTime() >= endsAt.getTime()) {
    return verdict('trial_expired', 'trial_over', { trialEndsAt: endsAt });
  }
  if (spend >= TRIAL_CEILING_MICROCENTS) {
    return verdict('trial_spent', 'trial_over', { trialEndsAt: endsAt });
  }
  return verdict('trial', null, { trialEndsAt: endsAt });
}

/** Whole days left in the trial, rounded up. 0 once it is over. Copy uses this. */
export function trialDaysRemaining(now: Date, createdAt: Date): number {
  const ms = trialEndsAt(createdAt).getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}
