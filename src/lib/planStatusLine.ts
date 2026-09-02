import type { AccountState } from '@/types/entitlement';

/**
 * One line describing the account's plan, for Settings -> Plan.
 *
 * Pure, and the clock is not read here — `trialDaysRemaining` is already
 * computed by `GET /api/me/entitlement`, so this file has nothing to be wrong
 * about on a laptop in a different timezone.
 *
 * Why it exists at all: Settings had a "Plan" card that said nothing about the
 * plan. It held Restore, Manage, and a paragraph about reinstalls. Guideline
 * 3.1.2 asks for the subscription to be discoverable and manageable from inside
 * the app, and a reviewer looking for "what am I on, and what does it cost"
 * should not have to infer it from the presence or absence of a paywall.
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
export function planStatusLine(state: AccountState, trialDaysRemaining: number): string {
  switch (state) {
    case 'trial':
      // `trialDaysRemaining` is whole days rounded UP and floored at 0, so 1
      // means "some part of one day left" — "1 day left" over-promises a full
      // day and "0 days left" reads as already over. Both are wrong; the honest
      // word is "today".
      return trialDaysRemaining > 1
        ? `Free trial — ${trialDaysRemaining} days left`
        : 'Free trial — ends today';

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
      return 'Subscribed';

    case 'subscribed_capped':
      return 'Subscribed — planning is paused on this account';

    // They cancelled and are still inside the period they paid for. Saying
    // "cancelled" alone would read as access already gone, which is the one
    // thing that is not true.
    case 'cancelled_in_period':
      return 'Subscribed — renewal is off';

    case 'billing_grace':
      return 'Subscribed — a payment needs attention';

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
