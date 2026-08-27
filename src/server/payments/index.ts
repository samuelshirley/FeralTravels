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
export {
  createTestAccount,
  listTestAccounts,
  readTestAccountOtp,
  resetTestAccount,
  ageTestAccount,
  deleteTestAccount,
  assertTestAddress,
  generateTestEmail,
  NotATestAccountError,
} from './testAccounts';
export type { TestAccountSummary, CreateTestAccountInput } from './testAccounts';
export { isTestPurchaseAllowed, testPurchasesArmed } from './testPurchase';
export { paywallEnabled } from './switch';
