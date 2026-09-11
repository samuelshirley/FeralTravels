/**
 * Undoing a break-glass revoke, as a PURE decision.
 *
 * No database, no `server-only`, no clock — same shape and same reason as
 * `states.ts`. What a re-activation does is decided entirely by two fields on
 * the row, so it can be described rather than staged, and `states.test.ts` can
 * walk a full revoke → re-activate round trip without writing one.
 *
 * WHY THIS EXISTS AT ALL. `revokeSubscription` overwrites `status` in place, so
 * the moment it runs the previous status is gone. `currentPeriodEnd`,
 * `productId` and `source` all survive, and not one of them can tell an active
 * plan from an expired one — so re-activating "back to active" would turn the
 * undo button into a way to mint free plans out of dead accounts. The fix is to
 * record what was there and consume it, which is what `pre_revoke_status` is.
 *
 * What this deliberately does NOT decide: whether the restored account is
 * entitled. That stays `resolveAccountState`'s job, from the restored status
 * plus the clock — which is why a plan whose period end passed while it was
 * revoked comes back `expired`, and correctly so. Re-activating hands back the
 * row, not time.
 */

import type { PreRevokeStatus, SubscriptionStatus } from '@/types/entitlement';

/** The two fields a revoke and its undo actually read. */
export interface RevocableRow {
  status: SubscriptionStatus;
  preRevokeStatus: PreRevokeStatus | null;
}

/** What `revokeSubscription` should write into `pre_revoke_status`. */
export function preRevokeStatusFor(existing: RevocableRow | null): PreRevokeStatus | null {
  // No row at all: the revoke is about to create one, and what an undo has to
  // restore is the ABSENCE of a row — a trial is derived from the sign-up date
  // and is never stored. Recording 'expired' here instead would be a lie that
  // outlives everyone who could correct it.
  if (!existing) return 'none';

  // Already revoked. Do NOT overwrite: a second revoke would otherwise record
  // `'revoked'` as the thing to restore, i.e. destroy the only field that makes
  // the undo possible, and the second press is exactly the one an admin makes
  // when they are unsure whether the first one worked.
  if (existing.status === 'revoked') return existing.preRevokeStatus;

  return existing.status;
}

export type ReactivationRefusal = 'no_subscription_row' | 'not_revoked' | 'no_pre_revoke_status';

export type ReactivationPlan =
  /** Restore `status` to what it was, and clear the revocation. */
  | { ok: true; action: 'restore'; status: SubscriptionStatus }
  /**
   * Delete the row. It only existed because the revoke created it, so the
   * account goes back to having no plan and the trial rules apply again —
   * which for an account older than seven days means `trial_expired`, exactly
   * where it stood the moment before the revoke.
   */
  | { ok: true; action: 'clear_row' }
  | { ok: false; reason: ReactivationRefusal; message: string };

/**
 * A refusal is never a silent no-op. Each of the three is a different mistake,
 * and an admin who presses the button needs to read which one they made — a
 * quiet success on an account that did not change is how a support thread ends
 * with two people believing different things about the same account.
 */
export function planReactivation(existing: RevocableRow | null): ReactivationPlan {
  if (!existing) {
    return {
      ok: false,
      reason: 'no_subscription_row',
      message:
        'This account has no plan row at all, so there is nothing to re-activate. ' +
        'It has never been revoked.',
    };
  }

  if (existing.status !== 'revoked') {
    return {
      ok: false,
      reason: 'not_revoked',
      message:
        `This account is not revoked — its plan is “${existing.status}”. ` +
        'Re-activating would change nothing, so nothing was changed.',
    };
  }

  if (existing.preRevokeStatus === null) {
    return {
      ok: false,
      reason: 'no_pre_revoke_status',
      message:
        'This account was revoked before the undo existed, so what its plan was ' +
        'beforehand is not recorded on the row and cannot be guessed. Read the ' +
        'subscription events below and set the status by hand.',
    };
  }

  if (existing.preRevokeStatus === 'none') return { ok: true, action: 'clear_row' };
  return { ok: true, action: 'restore', status: existing.preRevokeStatus };
}

/**
 * One line saying what the account lands back on, for the admin to read BEFORE
 * pressing the button.
 *
 * "Re-activated" is not a state. The admin is handing back a specific plan with
 * a specific end date, both of which are already on the row, and showing them
 * is the difference between undoing a mistake and making a second one.
 *
 * `periodEnd` is the row's `current_period_end`, pre-formatted by the caller
 * (the admin page renders dates in one place), and null means the row carries
 * no end date at all — an admin grant or a lifetime promo, i.e. genuinely
 * unlimited rather than unknown. It is deliberately NOT the page's
 * `paidThrough`, which is null for a date in the past: a term that expired
 * while the account was revoked is exactly the case this line has to be honest
 * about, and "no end date" would be the opposite of true.
 */
export function reactivationLandingLine(
  plan: ReactivationPlan,
  periodEnd: string | null,
): string | null {
  if (!plan.ok) return null;
  if (plan.action === 'clear_row') {
    return 'Lands back on: no plan at all. The seven-day trial rules apply again, exactly as they did before the revoke.';
  }
  const term = periodEnd ? `term ends ${periodEnd}` : 'no end date';
  return `Lands back on: ${plan.status}, ${term}. The clock still decides — a term that ran out while the account was revoked stays run out.`;
}
