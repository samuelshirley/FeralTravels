import type { AccountVerdict } from './states';
import type { PaywallCopy } from '@/types/entitlement';

/**
 * What Penny says when the trial runs out.
 *
 * This is chat copy, not modal copy, and the difference is the whole design.
 * The user does not get a sheet thrown over the app — they open it, land where
 * they always land, and Penny tells them herself. So it reads like her: first
 * person, no exclamation marks, no "Upgrade now", no feature grid.
 *
 * And it is SHORT. Penny is being warm about something the user did not ask
 * for, and warmth past two sentences turns into a speech. Say the one fact
 * (planning is paused), the one reassurance (nothing is gone), the one price,
 * and stop — the button underneath carries the rest.
 *
 * Served from the API rather than compiled into the app so it can be reworded
 * without cutting a TestFlight binary. The button label ships with it for the
 * same reason.
 */
export function paywallCopy(verdict: AccountVerdict): PaywallCopy | null {
  if (verdict.entitled) return null;

  switch (verdict.blockReason) {
    case 'usage_cap':
      // Not the user's fault and it must not read like an accusation. No
      // "limit", no "exceeded", no numbers they never agreed to.
      return {
        message:
          "I've had to pause planning — that's a ceiling on our costs, not anything you did. " +
          "Everything you've planned is still here. Drop us a line and we'll sort it out.",
        buttonLabel: 'Email support',
      };

    case 'revoked':
      return {
        message:
          "I can't plan on this account any more — if a refund went through, that's what " +
          "follows it. If that looks wrong, tell us and we'll fix it.",
        buttonLabel: 'Email support',
      };

    case 'subscription_over':
      // "Plan", never the s-word — the owner's call, and the word the whole
      // paywall now speaks in. The identifiers around it keep the old name.
      return {
        message:
          "Your plan's run out, so planning's paused. Nothing's been deleted — every trip " +
          "you've made is still here. Pick it back up whenever you like.",
        buttonLabel: 'Renew',
      };

    case 'trial_over':
    default:
      return {
        message:
          "That's your seven days up. Everything you've planned stays put — what's paused " +
          'is new trips and me.\n\n' +
          "It's $2 a month, or $20 for the year, whenever you want me back.",
        buttonLabel: 'Keep planning',
      };
  }
}

/**
 * The line prepended to Penny's onboarding greeting for a user still in trial.
 *
 * Prepended rather than baked into the greeting so a paid-up user never
 * reads about a trial they are not on, and so the greeting itself stays one
 * string with one owner in `src/server/onboarding.ts`.
 */
export function trialWelcomeLine(daysRemaining: number): string {
  if (daysRemaining <= 0) return '';
  if (daysRemaining === 1) return 'Welcome — this is the last day of your free trial.';
  return `Welcome to your ${spell(daysRemaining)}-day free trial.`;
}

function spell(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  return words[n] ?? String(n);
}
