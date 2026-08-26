/**
 * The shared wire contract for entitlement. Imported by the Next.js routes, the
 * web client and — via `scripts/sync-shared.mjs` — the Expo app, so the three
 * cannot drift into disagreeing about what "paywalled" means.
 */

/**
 * The eleven states from docs/design/subscriptions.md, plus `revoked`.
 *
 * Defined HERE rather than beside the resolver because this file is mirrored
 * into the Expo app by `scripts/sync-shared.mjs`, which rewrites `@/types/`
 * and `@/lib/` specifiers and nothing else. A type that lived under
 * `@/server/` could not cross that seam, and the app would end up with a
 * hand-copied duplicate of the one vocabulary all three tiers have to agree
 * on.
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

/**
 * Mirrors what Apple/RevenueCat report rather than inventing our own
 * vocabulary. `trialing` is deliberately absent — the trial is derived from
 * `users.created_at`, never stored, so a user in trial has no subscription row
 * at all.
 */
export type SubscriptionStatus =
  | 'active'
  | 'grace'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'revoked';

/** Where the entitlement came from. `fake` never exists in production data. */
export type SubscriptionSource = 'apple_iap' | 'promo' | 'admin' | 'fake';

/** Body of `GET /api/me/entitlement`. */
export interface EntitlementPayload {
  state: AccountState;
  entitled: boolean;
  canViewExistingTrips: boolean;
  blockReason: BlockReason | null;
  /** ISO8601, or null once the trial is irrelevant. */
  trialEndsAt: string | null;
  trialDaysRemaining: number;
  /** The paywall's own copy, server-authored so it can change without a build. */
  paywall: PaywallCopy | null;
  /** Prices to render. Empty when the user is entitled. */
  products: PaywallProduct[];
  /**
   * True only for accounts explicitly allowlisted for the fake purchase path.
   * The CLIENT never decides this — if the server says false, the test button
   * does not exist, and the endpoint refuses it anyway.
   */
  testPurchaseAllowed: boolean;
}

export interface PaywallProduct {
  id: string;
  /** e.g. "$2" */
  priceLabel: string;
  /** e.g. "per month" */
  cadence: string;
  /** Set on the annual plan only: "Save $4 a year". */
  note?: string;
}

export interface PaywallCopy {
  /** What Penny says. One message, in her voice — this is not modal copy. */
  message: string;
  /** Label on the button inside her bubble. */
  buttonLabel: string;
}

/**
 * Machine-readable code on a 402 body, alongside the existing `error` and
 * `errorId`. Clients branch on THIS, never on the message text — the copy is
 * meant to change.
 */
export const PAYWALL_ERROR_CODE = 'entitlement_required' as const;

export interface PaywallErrorBody {
  error: string;
  errorId?: string;
  code: typeof PAYWALL_ERROR_CODE;
  state: AccountState;
  blockReason: BlockReason;
}
