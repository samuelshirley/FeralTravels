import type { BlockReason } from '@/types/entitlement';

/**
 * What the web says to a signed-in user it has just refused.
 *
 * Pure data, no `server-only`: the server component renders it and the unit
 * test reads it. Kept OUT of `src/server/payments/` on purpose — that module
 * decides whether someone is entitled, and copy is not that decision.
 *
 * The four reasons get four strings and share none of them. Two of them are a
 * sales moment and two of them are an apology, and a single "your access has
 * ended" sentence stretched across all four would be wrong in at least three
 * ways at once.
 */

/**
 * Where "Continue on iPhone" goes.
 *
 * The numeric id is minted by App Store Connect at first submission, so it is
 * an env var rather than a hardcoded guess — a wrong id is a 404 in front of
 * the one screen whose entire job is to sell. Until it is set, the search URL
 * is a real, working Apple page that finds the app, which is a better failure
 * than a dead link.
 */
export const APP_STORE_URL =
  process.env.NEXT_PUBLIC_APP_STORE_URL || 'https://apps.apple.com/search?term=Feral%20Travels';

/** One inbox, one human. Same address as `/support`. */
export const SUPPORT_EMAIL = 'support@feraltravels.com';

export interface BlockNotice {
  /** Small uppercase kicker above the heading. */
  eyebrow: string;
  heading: string;
  /** One or two short paragraphs. Rendered in order. */
  body: string[];
  action: { label: string; href: string };
  /**
   * `sell` renders the primary blue button (App Store).
   * `apologise` renders a quieter one (mailto support) — a capped or revoked
   * user is not a lead, and styling them as one would read as tone-deaf.
   */
  tone: 'sell' | 'apologise';
}

const TRIAL_OVER: BlockNotice = {
  eyebrow: 'TRIAL ENDED',
  heading: 'Your free trial is over',
  body: [
    'Everything you have already planned is still here and still readable — the trip list, every day, every fuel stop. What is paused is new trips and talking to Penny.',
    'Subscriptions are handled through the App Store, so the way back in is the iPhone app: $2 a month, or $20 a year. Subscribe there and the web picks up exactly where you left off.',
  ],
  action: { label: 'Continue on iPhone', href: APP_STORE_URL },
  tone: 'sell',
};

const SUBSCRIPTION_OVER: BlockNotice = {
  eyebrow: 'SUBSCRIPTION ENDED',
  heading: 'Your subscription has run out',
  body: [
    'The paid period on this account has ended, so new trips and Penny are paused. Nothing has been deleted — your trips stay readable here for as long as you want them.',
    'Renewing happens in the iPhone app, the same place it started. It takes a tap, and planning switches straight back on.',
  ],
  action: { label: 'Renew on iPhone', href: APP_STORE_URL },
  tone: 'sell',
};

/**
 * The cap. This copy is the reason `BlockReason` exists as a separate field
 * from `AccountState`.
 *
 * A user hitting $8.50 of Anthropic spend in twelve months has almost
 * certainly not done anything unusual — it means our per-trip cost regressed,
 * which is our problem and not theirs. So: no "limit exceeded", no "excessive
 * usage", nothing that reads as an accusation. It points at support, and
 * support is one person who actually replies.
 */
const USAGE_CAP: BlockNotice = {
  eyebrow: 'PLANNING PAUSED',
  heading: 'We have paused planning on this account',
  body: [
    'This is a ceiling on our own costs, not a judgement about how you have used the app — you have not done anything wrong, and nothing you have planned has been touched. Your trips stay readable.',
    'Email us and we will sort it out. A real person reads that inbox and will reply — this is exactly the kind of message we want to get.',
  ],
  action: { label: `Email ${SUPPORT_EMAIL}`, href: `mailto:${SUPPORT_EMAIL}` },
  tone: 'apologise',
};

/**
 * Refunded or revoked. The only case where existing trips also close, so this
 * is the one message that cannot promise the itinerary is still there.
 *
 * Says what happened without accusing anyone of anything: a refund is between
 * the user and Apple, and a revoke is rare enough that if it is wrong, we want
 * to hear about it rather than defend it.
 */
const REVOKED: BlockNotice = {
  eyebrow: 'ACCESS CLOSED',
  heading: 'Access to this account is closed',
  body: [
    'Planning and your saved trips are both unavailable on this account. If a refund went through on the App Store, this is what follows it — the purchase was returned, so the access it bought ended with it.',
    'If that looks wrong to you, email us. A real person reads it, and getting this wrong is very much a thing we would want to fix.',
  ],
  action: { label: `Email ${SUPPORT_EMAIL}`, href: `mailto:${SUPPORT_EMAIL}` },
  tone: 'apologise',
};

const NOTICES: Record<BlockReason, BlockNotice> = {
  trial_over: TRIAL_OVER,
  subscription_over: SUBSCRIPTION_OVER,
  usage_cap: USAGE_CAP,
  revoked: REVOKED,
};

export function blockNoticeFor(reason: BlockReason): BlockNotice {
  return NOTICES[reason];
}
