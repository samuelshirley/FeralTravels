/**
 * Payments — the bounded module.
 *
 * THIS FILE IS THE ONLY THING THE REST OF THE APP MAY IMPORT. Routes, guards,
 * the admin panel and the chat all go through here; nothing outside
 * `src/server/payments/` should ever import `./entitlements`, `./states` or
 * reach for the `subscriptions` table directly.
 *
 * The convention amendment is deliberate (docs/design/ios-app-plan.md): every
 * other domain keeps its DB access in `src/server/repos/`, and payments does
 * not. A repo file is a shared surface that anything may call; the whole value
 * of this module is that the number of places able to decide "this user has
 * paid" stays at one. It is a boundary, not a separate deployment — that was
 * considered and rejected as over-engineering for a single-developer app.
 *
 * The single public question is `hasEntitlement(userId)`.
 */

export { hasEntitlement, getAccountVerdict, getTrialDaysRemaining } from './entitlements';
export { upsertSubscription, revokeSubscription, getSubscriptionRow } from './entitlements';
export { isCompedEmail, syncCompedFlagOnSignIn } from './comped';
export { maybeAlertThreshold, alertAlreadyFired } from './alerts';
export { anthropicMicrocentsInWindow } from './usage';
export {
  PRODUCTS,
  TRIAL_DAYS,
  MICROCENTS_PER_DOLLAR,
  WATCH_MICROCENTS,
  STOP_MICROCENTS,
  TRIAL_CEILING_MICROCENTS,
  isProductId,
  productById,
} from './constants';
export type { ProductId } from './constants';
export { resolveAccountState, trialDaysRemaining, trialEndsAt } from './states';
export type { AccountState, AccountVerdict, AccountFacts, BlockReason } from './states';
export { applySubscriptionEvent, decideFromEvent, isKnownEventType } from './webhook';
export type { WebhookOutcome, WebhookResult, WebhookDeps, EventDecision } from './webhook';
export { revenueCatWebhookSchema, normalizeWebhookEvent } from './schemas';
export type { RevenueCatWebhookBody, NormalizedSubscriptionEvent } from './schemas';
/**
 * `./testAccounts` is deliberately NOT re-exported here.
 *
 * It reaches `repos/trips` and `repos/vehicles` to build a realistic account,
 * and those pull Auth.js in behind them. Re-exporting it put next-auth on the
 * import path of everything that touches this module — including the
 * RevenueCat webhook route, whose tests then died at collection on
 * `Cannot find module 'next/server'` (next 14 ships no `./server` export map,
 * so an extensionless ESM import of it cannot resolve anywhere, CI included).
 *
 * The single-public-surface rule exists so that ONE place decides whether a
 * user has paid. Fixture tooling is not that decision, and importing
 * `@/server/payments/testAccounts` directly — as `/api/admin/test-users` does
 * — keeps the entitlement surface cheap to import.
 */
export { isTestPurchaseAllowed, testPurchasesArmed } from './testPurchase';
export { paywallEnabled } from './switch';
/**
 * Promo codes belong on this surface, unlike `./testAccounts`: redeeming one
 * writes an ordinary `subscriptions` row through `upsertSubscription`, so it is
 * a way of BECOMING entitled and the module that owns that decision should be
 * the one that exposes it. It pulls in nothing beyond what `./entitlements`
 * already imports.
 */
export {
  createPromoCode,
  redeemPromoCode,
  listPromoCodes,
  countOutstandingPromoCodes,
  /**
   * The sign-in auto-claim. On this surface rather than imported directly for
   * the same reason redeem is: it is a way of BECOMING entitled, and the module
   * that owns that decision should be the one that exposes it.
   */
  claimPromoOnSignIn,
  PROMO_GRANT_MONTHS,
  isPromoGrantMonths,
  addMonthsUTC,
} from './promo';
export type {
  CreatePromoCodeInput,
  PromoCodeRow,
  RedeemResult,
  PromoGrantMonths,
} from './promo';
