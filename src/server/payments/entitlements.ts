import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { subscriptionEvents, subscriptions, users } from '@/server/db/schema';
import type { SubscriptionSource, SubscriptionStatus } from '@/server/db/schema';
import { planReactivation, preRevokeStatusFor, type ReactivationPlan } from './reactivation';
import { anthropicMicrocentsInWindow } from './usage';
import { resolveAccountState, trialDaysRemaining, type AccountVerdict } from './states';
import { enforcementApplies, paywallEnabled } from './switch';

/**
 * Apply the master switch to a true verdict.
 *
 * The STATE is left exactly as the resolver found it — an account that is
 * `trial_expired` still says so, and the admin panel still shows it — because
 * a switch that rewrote history would make it impossible to see who WOULD be
 * blocked before turning it on. Only the three fields that gate behaviour are
 * overridden.
 *
 * `forcedForUser` is the per-account override (`users.paywall_enforced`): this
 * one account is enforced even while the global switch is off, so the wall can
 * be walked into on a deployment where nobody else can see it. It defaults to
 * false and is compared with `=== true`, so an absent option, an undefined
 * column on an older row, or a failed read all mean "not enforced" — the same
 * direction `paywallEnabled()` fails in, and for the same reason.
 */
export async function applySwitch(
  verdict: AccountVerdict,
  opts?: { forcedForUser?: boolean }
): Promise<AccountVerdict> {
  const enforced = enforcementApplies({
    globalOn: await paywallEnabled(),
    forcedForUser: opts?.forcedForUser === true,
  });
  if (enforced) return verdict;
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
      .select({
        createdAt: users.createdAt,
        comped: users.comped,
        // Read in the query that was already being made: the per-account
        // override costs nothing on the hot path it gates.
        paywallEnforced: users.paywallEnforced,
      })
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
    return await applySwitch(
      resolveAccountState({
        now,
        createdAt: new Date(0),
        comped: false,
        anthropicMicrocents12mo: 0,
        subscription: null,
      })
    );
  }

  return await applySwitch(
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
    }),
    { forcedForUser: user.paywallEnforced }
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
        // revoked and later pays again is a customer, not a suspect. The
        // pre-revoke status goes with it: it is the undo's memory of a
        // revocation that no longer exists, and a stale one on a live row
        // would be read months later as though it meant something.
        revokedAt: null,
        revokedBy: null,
        revokedReason: null,
        preRevokeStatus: null,
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

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ status: subscriptions.status, preRevokeStatus: subscriptions.preRevokeStatus })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    await tx
      .insert(subscriptions)
      .values({
        userId,
        status: 'revoked',
        source: 'admin',
        // No row existed, so this revoke is creating one. What an undo has to
        // restore is the ABSENCE of a row — see `preRevokeStatusFor`.
        preRevokeStatus: 'none',
        revokedAt: now,
        revokedBy: by,
        revokedReason: trimmed,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subscriptions.userId,
        set: {
          status: 'revoked',
          /**
           * The status this is about to overwrite, kept so the revoke can be
           * undone — and computed in SQL against the EXISTING row rather than
           * from the value read above, so a concurrent write cannot land
           * between the read and this statement and get memorialised wrong.
           *
           * The CASE is the double-revoke rule: pressing revoke twice must not
           * record `'revoked'` as the thing to restore, which would destroy the
           * one field that makes the undo possible. `preRevokeStatusFor` states
           * the same rule in TypeScript and is what the unit tests exercise;
           * these two must agree.
           */
          preRevokeStatus: sql`case when ${subscriptions.status} = 'revoked'
              then ${subscriptions.preRevokeStatus}
              else ${subscriptions.status} end`,
          revokedAt: now,
          revokedBy: by,
          revokedReason: trimmed,
          updatedAt: now,
        },
      });

    await recordAdminSubscriptionAction(tx, {
      userId,
      type: 'ADMIN_REVOKE',
      by,
      reason: trimmed,
      at: now,
      detail: { previousStatus: preRevokeStatusFor(existing[0] ?? null) },
    });
  });
}

/**
 * The undo. Break-glass in the recoverable direction, and the only thing that
 * moves a row out of `revoked`.
 *
 * Requires a typed reason and records who pressed it, for exactly the same
 * reason its opposite does: handing paid access back is a decision somebody
 * has to be able to explain months later, and the two entries have to read as
 * a pair. It is NOT the quieter half of the pair in the audit, only in the UI.
 *
 * Returns the plan it carried out, or the refusal — a re-activation that
 * cannot happen must SAY so. A silent no-op is how an admin comes away
 * believing they fixed an account that is still locked out.
 */
export async function reactivateSubscription(
  userId: string,
  by: string,
  reason: string
): Promise<ReactivationPlan> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('reactivateSubscription requires a reason');
  const now = new Date();

  return db.transaction(async (tx) => {
    // Locked for the length of the transaction: two admins pressing the button
    // together must not both come away told they restored the account. The
    // second waits, re-reads an un-revoked row and is refused with
    // `not_revoked`, which is the truth by then.
    const rows = await tx
      .select({ status: subscriptions.status, preRevokeStatus: subscriptions.preRevokeStatus })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1)
      .for('update');

    const plan = planReactivation(rows[0] ?? null);
    if (!plan.ok) return plan;

    if (plan.action === 'clear_row') {
      await tx.delete(subscriptions).where(eq(subscriptions.userId, userId));
    } else {
      await tx
        .update(subscriptions)
        .set({
          status: plan.status,
          // Consumed. Leaving it set would make a later revoke of this same
          // account restore a status two revocations old.
          preRevokeStatus: null,
          // Cleared because the account is no longer revoked and the row must
          // not say it is. The FACT of the revoke is not lost — it is in
          // `subscription_events`, which is written below and never deleted,
          // and is why clearing these is safe rather than tidy.
          revokedAt: null,
          revokedBy: null,
          revokedReason: null,
          updatedAt: now,
        })
        .where(eq(subscriptions.userId, userId));
    }

    await recordAdminSubscriptionAction(tx, {
      userId,
      type: 'ADMIN_REACTIVATE',
      by,
      reason: trimmed,
      at: now,
      detail:
        plan.action === 'clear_row'
          ? { restoredStatus: null, removedRow: true }
          : { restoredStatus: plan.status },
    });

    return plan;
  });
}

/**
 * Both admin entitlement actions, through the same ledger a real webhook uses.
 *
 * The property being defended is one sentence: an admin action that changes
 * entitlement must never leave no row saying who did it. `subscriptions` has
 * three columns for that and they only describe the LATEST revoke — clearing
 * them on an undo would erase the fact that a revoke ever happened, and a
 * second revoke overwrites the first regardless. An append-only ledger is the
 * shape that answers "what has been done to this account", which is the
 * question actually asked when somebody writes in.
 *
 * `eventTimeMs` is our own clock, matching `PROMO_REDEEMED` and
 * `FAKE_PURCHASE` — the two other non-store rows in this table. It has a
 * consequence worth naming: `lastAppliedEventTimeMs` takes the newest applied
 * timestamp, so a store event that was delayed in flight and carries an older
 * one is ignored as stale afterwards. For a deliberate admin decision made
 * seconds ago that is the behaviour we want, and it is the same trade the
 * promo path already makes.
 */
async function recordAdminSubscriptionAction(
  tx: Pick<typeof db, 'insert'>,
  entry: {
    userId: string;
    type: 'ADMIN_REVOKE' | 'ADMIN_REACTIVATE';
    by: string;
    reason: string;
    at: Date;
    detail: Record<string, unknown>;
  }
): Promise<void> {
  await tx.insert(subscriptionEvents).values({
    // Not derived from anything on the row: an admin may revoke, undo and
    // revoke the same account again, and every one of those is its own entry.
    eventId: `admin:${entry.type.toLowerCase()}:${randomUUID()}`,
    userId: entry.userId,
    type: entry.type,
    eventTimeMs: entry.at.getTime(),
    payload: { by: entry.by, reason: entry.reason, ...entry.detail },
    outcome: 'applied',
  });
}

/**
 * Turn the per-account paywall override on or off. The only writer.
 *
 * Admin-only, one account at a time, and deliberately not derivable from
 * anything — no email allowlist, no "all test users", no environment variable.
 * The whole value of this flag is that its blast radius is one row you named,
 * on a deployment where the paywall is off for everybody else.
 *
 * `logUsageEvent` is the caller's job, exactly as it is for the global switch:
 * `users` has nowhere to record who flipped it, and "who paywalled this
 * account" is the first question asked when somebody is blocked and should not
 * be.
 */
export async function setPaywallEnforcedForUser(userId: string, on: boolean): Promise<void> {
  await db.update(users).set({ paywallEnforced: on }).where(eq(users.id, userId));
}

/** Current row as-is, for the admin panel. Not an entitlement answer. */
export async function getSubscriptionRow(userId: string) {
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  return rows[0] ?? null;
}
