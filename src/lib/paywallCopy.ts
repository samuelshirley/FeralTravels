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
 *
 * Length is a deliberate constraint here, not an accident of drafting. Each
 * notice is a paragraph the user reads while being told no; the friendliness
 * is the point, but every extra clause restating what the previous one already
 * said makes it read as an excuse. Two short paragraphs, one fact each. If a
 * rewrite grows one back to four lines, cut it again.
 */

/**
 * A word this file never says: "subscribe", "subscription", "subscriber".
 *
 * Not a style preference — the owner's call, and `paywallCopy.test.ts` fails
 * the suite if one comes back. The user reads "plan": pick a plan, your plan,
 * keep planning. The identifiers, the table and the types keep the old names,
 * because renaming those would only make the code harder to follow for no
 * reader's benefit.
 */

/**
 * Where the App Store button goes.
 *
 * The numeric id is minted by App Store Connect at first submission, so it is
 * an env var rather than a hardcoded guess — a wrong id is a 404 in front of
 * the one screen whose entire job is to sell. Until it is set, the search URL
 * is a real, working Apple page that finds the app, which is a better failure
 * than a dead link.
 */
export const APP_STORE_URL =
  process.env.NEXT_PUBLIC_APP_STORE_URL || 'https://apps.apple.com/search?term=Feral%20Travels';

/**
 * The label on the one web button that leaves the web.
 *
 * Lives here rather than inline in `PurchaseSheet` so there is a single place
 * to reword it and a single string for the banned-word sweep in
 * `paywallCopy.test.ts` to see. It says where the tap lands — the iPhone app —
 * because "Continue" alone reads as "continue in this browser", which is the
 * one thing the web cannot do with a purchase.
 */
export const APP_STORE_CTA_LABEL = 'Continue to the iPhone app';

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
    'Everything you have planned is still here — nothing has been deleted. What is paused is new trips and talking to Penny.',
    'It is $2 a month or $20 a year, from the iPhone app. Pick one and the web carries on where you left off.',
  ],
  // The label has to work twice: as the button that opens the purchase sheet,
  // and as the plain App Store link it degrades to when the entitlement call
  // fails and there are no prices to put in a sheet. It is NOT the App Store
  // button's own label — that one is APP_STORE_CTA_LABEL, and it says where it
  // goes because that tap really does leave the browser.
  action: { label: 'Pick a plan', href: APP_STORE_URL },
  tone: 'sell',
};

const SUBSCRIPTION_OVER: BlockNotice = {
  eyebrow: 'PLAN ENDED',
  heading: 'Your plan has run out',
  body: [
    'New trips and Penny are paused. Nothing has been deleted — your trips stay here for as long as you want them.',
    'Renewing is a tap in the iPhone app, and planning switches straight back on.',
  ],
  action: { label: 'Renew your plan', href: APP_STORE_URL },
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
    'This is a ceiling on our own costs, not a judgement about you. Nothing you have planned has been touched, and your trips stay readable.',
    'Email us and we will sort it out — a real person reads that inbox, and this is exactly the kind of message we want to get.',
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
    'Planning and your saved trips are both unavailable here. If a refund went through on the App Store, this is what follows it.',
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
