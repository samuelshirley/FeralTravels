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
import type { SubscriptionStatus } from '@/server/db/schema';

/**
 * The eleven states from the design doc, plus `revoked`.
 *
 * `revoked` is the break-glass admin action. The doc enumerates eleven states
 * and does not list it, because it describes what happens to users rather than
 * what we can do to them — but it produces a distinct blocked account that the
 * admin panel has to be able to show and explain, so it is a state here.
 */
export type AccountState =
  | 'trial'
  | 'trial_spent'
  | 'trial_expired'
  | 'subscribed'
  | 'subscribed_watch'
  | 'subscribed_capped'
  | 'cancelled_in_period'
  | 'expired'
  | 'billing_grace'
  | 'refunded'
  | 'revoked'
  | 'comped';

/** Why access was refused. Drives the copy, which is NOT the same in each case. */
export type BlockReason =
  /** Trial is over. This is a sales moment. */
  | 'trial_over'
  /** Paid period ended, or Apple stopped renewing. Also a sales moment. */
  | 'subscription_over'
  /** Over the usage cap. NOT the user's fault — points at support, never accuses. */
  | 'usage_cap'
  /** Refunded or revoked. Everything is closed, including existing trips. */
  | 'revoked';

export interface SubscriptionFacts {
  status: SubscriptionStatus;
  /** Null means no end date — an admin grant or a lifetime promo. */
  currentPeriodEnd: Date | null;
  autoRenew: boolean;
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
   * The 12-month Anthropic figure the verdict was decided on, passed straight
   * back out. The alert email reports it, and a caller that re-queried for it
   * could report a number the decision was never made on.
   */
  spendMicrocents: number;
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
