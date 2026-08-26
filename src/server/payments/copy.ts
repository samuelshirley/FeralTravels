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
          "I've had to pause planning on your account — that's a ceiling on our costs, " +
          "not anything you did wrong. Everything you've already planned is still here. " +
          'Drop us a line and a real person will sort it out.',
        buttonLabel: 'Email support',
      };

    case 'revoked':
      return {
        message:
          "I can't plan on this account any more. If a refund went through, that's what " +
          "follows it. If that looks wrong to you, tell us — we'd want to fix it.",
        buttonLabel: 'Email support',
      };

    case 'subscription_over':
      return {
        message:
          "Your subscription's run out, so I've had to stop planning for now. " +
          "Nothing's been deleted — every trip you've made is still here to read. " +
          'Pick it back up whenever you like.',
        buttonLabel: 'Renew',
      };

    case 'trial_over':
    default:
      return {
        message:
          "That's your seven days up. I hope they were useful.\n\n" +
          "Everything you've planned so far stays here and stays readable — what's " +
          "paused is new trips and me. If you'd like to keep going, it's $2 a month " +
          'or $20 for the year.',
        buttonLabel: 'Keep planning',
      };
  }
}

/**
 * The line prepended to Penny's onboarding greeting for a user still in trial.
 *
 * Prepended rather than baked into the greeting so a subscribed user never
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
