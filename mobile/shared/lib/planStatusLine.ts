import { formatPlanDate } from '../lib/dates';
import type { AccountState } from '../types/entitlement';

/**
 * One line describing the account's plan, for Settings -> Plan.
 *
 * Pure, and the clock is an ARGUMENT. `now` is only ever used to decide whether
 * a date needs its year, so this file has nothing to be wrong about on a laptop
 * in a different timezone and the year boundary is testable without waiting for
 * one.
 *
 * Why it exists at all: Settings had a "Plan" card that said nothing about the
 * plan. It held Restore, Manage, and a paragraph about reinstalls. Guideline
 * 3.1.2 asks for the subscription to be discoverable and manageable from inside
 * the app, and a reviewer looking for "what am I on, and what does it cost"
 * should not have to infer it from the presence or absence of a paywall.
 *
 * It then said "Subscribed" and nothing else, which was the same failure one
 * step in: twelve flat strings, no product, no date. A status line that omits
 * WHICH plan and WHEN it renews is not a status line — the two facts a
 * subscriber opens this screen to check are exactly those, and both were on the
 * `subscriptions` row the whole time and simply not on the wire.
 *
 * The copy is deliberately flat and short. This is a status line, not a sales
 * moment — the sales copy is server-authored in `payments/copy.ts` and belongs
 * on the surfaces that block. Nothing here accuses anyone of anything, and the
 * two states that are somebody else's problem to fix (`subscribed_capped`,
 * `billing_grace`) say what is happening without implying the reader caused it.
 *
 * Mirrored into the Expo app by `scripts/sync-shared.mjs` so both clients say
 * the same thing, and unit-tested from the root project because `mobile/` has
 * no test runner.
 */
export interface PlanStatus {
  state: AccountState;
  /** Whole days, rounded up, floored at 0. From the entitlement payload. */
  trialDaysRemaining: number;
  /** ISO8601, or null once the trial is irrelevant. */
  trialEndsAt: string | null;
  /** Which product, or null for a trial, an admin comp or a promo. */
  plan: 'monthly' | 'annual' | null;
  /** ISO8601. NULL MEANS NO END — a comp or a lifetime promo, not "unknown". */
  currentPeriodEnd: string | null;
  autoRenew: boolean;
}

/**
 * What to call the thing they are on.
 *
 * Falls back to "Subscribed" rather than inventing a plan name. An entitled
 * account with no product id is real and ordinary — an admin comp, a redeemed
 * promo — and "Monthly plan" would be a straightforward lie about a row that
 * says no such thing.
 */
function planLabel(plan: PlanStatus['plan']): string {
  if (plan === 'annual') return 'Annual plan';
  if (plan === 'monthly') return 'Monthly plan';
  return 'Subscribed';
}

export function planStatusLine(status: PlanStatus, now: Date): string {
  const { state, trialDaysRemaining, trialEndsAt, plan, currentPeriodEnd } = status;

  /**
   * The date clause, or nothing at all.
   *
   * Returning null on a null date is the whole point: a comped account has no
   * `currentPeriodEnd`, and every one of the branches below has to be able to
   * drop its date rather than render "renews null" at somebody. Asserted.
   */
  const on = (iso: string | null): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : formatPlanDate(d, now);
  };

  const label = planLabel(plan);
  const ends = on(currentPeriodEnd);

  switch (state) {
    case 'trial': {
      const until = on(trialEndsAt);
      // `trialDaysRemaining` is whole days rounded UP and floored at 0, so 1
      // means "some part of one day left" — "1 day left" over-promises a full
      // day and "0 days left" reads as already over. Both are wrong; the honest
      // word is "today", and on the last day the date adds nothing.
      if (trialDaysRemaining <= 1) return 'Free trial — ends today';
      // The count answers "how long have I got", the date answers "when do I
      // need to decide by". They are different questions and both fit.
      return until
        ? `Free trial — ${trialDaysRemaining} days left, ends ${until}`
        : `Free trial — ${trialDaysRemaining} days left`;
    }

    // The trial can end two ways and the distinction matters to us, not to the
    // reader: `trial_spent` is our $1 Anthropic ceiling, `trial_expired` is the
    // seventh day. Telling somebody their trial ended because of what it cost
    // us invites an argument about a number they cannot see.
    case 'trial_spent':
    case 'trial_expired':
      return 'Free trial ended';

    case 'subscribed':
    // `subscribed_watch` is an ADMIN alert threshold. Nothing about it is
    // user-visible or user-actionable, and it entitles exactly like
    // `subscribed` — so it must read identically here.
    case 'subscribed_watch':
      return ends ? `${label} — renews ${ends}` : label;

    case 'subscribed_capped':
      return `${label} — planning is paused on this account`;

    // They cancelled and are still inside the period they paid for. Leading
    // with "cancelled" would read as access already gone, which is the one
    // thing that is not true — so the DATE comes first and the renewal fact
    // second.
    case 'cancelled_in_period':
      return ends ? `${label} — ends ${ends}, won't renew` : `${label} — won't renew`;

    case 'billing_grace':
      return `${label} — a payment needs attention`;

    case 'expired':
      return 'Subscription ended';

    case 'refunded':
      return 'Subscription refunded';

    case 'revoked':
      return 'Subscription cancelled';

    case 'comped':
      return 'Complimentary plan';

    default: {
      // A thirteenth state fails `tsc` here rather than rendering an empty line
      // on a screen nobody thinks to re-check. Same shape as the exhaustive
      // switches in `payments/`.
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
