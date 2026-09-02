import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { subscriptions, users } from '@/server/db/schema';
import type { SubscriptionSource, SubscriptionStatus } from '@/server/db/schema';
import { anthropicMicrocentsInWindow } from './usage';
import { resolveAccountState, trialDaysRemaining, type AccountVerdict } from './states';
import { paywallEnabled } from './switch';

/**
 * Apply the master switch to a true verdict.
 *
 * The STATE is left exactly as the resolver found it — an account that is
 * `trial_expired` still says so, and the admin panel still shows it — because
 * a switch that rewrote history would make it impossible to see who WOULD be
 * blocked before turning it on. Only the three fields that gate behaviour are
 * overridden.
 */
export function applySwitch(verdict: AccountVerdict): AccountVerdict {
  if (paywallEnabled()) return verdict;
  return {
    ...verdict,
    enforced: false,
    entitled: true,
    canViewExistingTrips: true,
    blockReason: null,
  };
}

/**
 * Fetch the facts, hand them to the pure resolver.
 *
 * Everything interesting lives in `states.ts`; this file exists so that only
 * one place in the codebase knows how a verdict is assembled from the
 * database, and so the resolver stays testable without one.
 */
export async function getAccountVerdict(userId: string, now = new Date()): Promise<AccountVerdict> {
  const [userRows, subRows, spend] = await Promise.all([
    db
      .select({ createdAt: users.createdAt, comped: users.comped })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        autoRenew: subscriptions.autoRenew,
        // Display only — Settings says "Annual plan" rather than "Subscribed".
        // Nothing in `resolveAccountState` reads it.
        productId: subscriptions.productId,
        // Display only. Tells "Ambassador plan" from "Monthly plan".
        source: subscriptions.source,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1),
    anthropicMicrocentsInWindow(userId),
  ]);

  const user = userRows[0];
  if (!user) {
    // The session outlived the row (deleted account mid-request). Refuse rather
    // than fabricating a trial for a user that does not exist.
    return applySwitch(
      resolveAccountState({
        now,
        createdAt: new Date(0),
        comped: false,
        anthropicMicrocents12mo: 0,
        subscription: null,
      })
    );
  }

  return applySwitch(
    resolveAccountState({
      now,
      createdAt: user.createdAt,
      comped: user.comped,
      anthropicMicrocents12mo: spend,
      subscription: subRows[0]
        ? {
            status: subRows[0].status,
            currentPeriodEnd: subRows[0].currentPeriodEnd,
            autoRenew: subRows[0].autoRenew,
            productId: subRows[0].productId,
            source: subRows[0].source,
          }
        : null,
    })
  );
}

/**
 * THE question. One boolean, one import, for every route that spends money.
 *
 * Callers must not re-derive this from a status column, a date or an email —
 * if the rule changes (and it did once already, when cancellation stopped
 * meaning "blocked"), it changes here and nowhere else.
 */
export async function hasEntitlement(userId: string, now = new Date()): Promise<boolean> {
  const verdict = await getAccountVerdict(userId, now);
  return verdict.entitled;
}

/** Days left in the trial, for the copy in Penny's greeting. */
export async function getTrialDaysRemaining(userId: string, now = new Date()): Promise<number> {
  const rows = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!rows[0]) return 0;
  return trialDaysRemaining(now, rows[0].createdAt);
}

export interface UpsertSubscriptionInput {
  userId: string;
  status: SubscriptionStatus;
  source: SubscriptionSource;
  productId?: string | null;
  currentPeriodEnd?: Date | null;
  originalTransactionId?: string | null;
  autoRenew?: boolean;
}

/**
 * The ONLY writer of the `subscriptions` table outside the admin break-glass.
 *
 * Callable from the webhook handler and from the allowlisted test-purchase
 * route — never from anything holding a client-supplied receipt. A receipt the
 * app sends us is a claim, not proof; the webhook is the proof.
 */
export async function upsertSubscription(input: UpsertSubscriptionInput): Promise<void> {
  const now = new Date();
  await db
    .insert(subscriptions)
    .values({
      userId: input.userId,
      status: input.status,
      source: input.source,
      productId: input.productId ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      originalTransactionId: input.originalTransactionId ?? null,
      autoRenew: input.autoRenew ?? true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: {
        status: input.status,
        source: input.source,
        productId: input.productId ?? null,
        currentPeriodEnd: input.currentPeriodEnd ?? null,
        originalTransactionId: input.originalTransactionId ?? null,
        autoRenew: input.autoRenew ?? true,
        // A new purchase clears any previous revocation. Someone who was
        // revoked and later pays again is a customer, not a suspect.
        revokedAt: null,
        revokedBy: null,
        revokedReason: null,
        updatedAt: now,
      },
    });
}

/**
 * Admin break-glass. Requires a typed reason and records who pressed it.
 *
 * Everything routine is automatic — the cap blocks at $8.50 on its own and a
 * `REFUND` notification revokes on its own. If this is ever the normal way
 * something happens, the automation is broken. Cancelling is NOT a reason to
 * press it: a cancelled subscriber keeps the term they bought.
 */
export async function revokeSubscription(
  userId: string,
  by: string,
  reason: string
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('revokeSubscription requires a reason');
  const now = new Date();
  await db
    .insert(subscriptions)
    .values({
      userId,
      status: 'revoked',
      source: 'admin',
      revokedAt: now,
      revokedBy: by,
      revokedReason: trimmed,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: {
        status: 'revoked',
        revokedAt: now,
        revokedBy: by,
        revokedReason: trimmed,
        updatedAt: now,
      },
    });
}

/** Current row as-is, for the admin panel. Not an entitlement answer. */
export async function getSubscriptionRow(userId: string) {
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  return rows[0] ?? null;
}
