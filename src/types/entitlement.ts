/**
 * The shared wire contract for entitlement. Imported by the Next.js routes, the
 * web client and — via `scripts/sync-shared.mjs` — the Expo app, so the three
 * cannot drift into disagreeing about what "paywalled" means.
 */

import type { AccountState, BlockReason } from '@/server/payments/states';

export type { AccountState, BlockReason };

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
