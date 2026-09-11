import { describe, expect, it } from 'vitest';
import { APP_STORE_CTA_LABEL, blockNoticeFor, SUPPORT_EMAIL } from './paywallCopy';
import { paywallCopy, trialWelcomeLine } from '@/server/payments/copy';
import type { AccountVerdict } from '@/server/payments';
import type { AccountState, BlockReason, PaywallCopy } from '@/types/entitlement';

const ALL: BlockReason[] = ['trial_over', 'subscription_over', 'usage_cap', 'revoked'];

const STATE_FOR: Record<BlockReason, AccountState> = {
  trial_over: 'trial_expired',
  subscription_over: 'expired',
  usage_cap: 'subscribed_capped',
  revoked: 'revoked',
};

/** A refused verdict, shaped the way `resolveAccountState` would return one. */
function refusal(blockReason: BlockReason): AccountVerdict {
  return {
    state: STATE_FOR[blockReason],
    entitled: false,
    canViewExistingTrips: blockReason !== 'revoked',
    blockReason,
    trialEndsAt: null,
    crossedWatch: false,
    crossedStop: false,
    enforced: true,
    spendMicrocents: 0,
    // Display-only passthrough on the verdict. Irrelevant to copy, but the
    // type is exhaustive on purpose, so a new field has to be answered here
    // rather than silently defaulted.
    productId: null,
    currentPeriodEnd: null,
    autoRenew: false,
    source: null,
  };
}

/**
 * Penny's copy for one block reason.
 *
 * `paywallCopy` returns null for an ENTITLED verdict, which none of these are —
 * a null here would mean the copy layer thinks a refused account has nothing to
 * be told, so it is asserted rather than defaulted away.
 */
function pennyCopyFor(reason: BlockReason): PaywallCopy {
  const copy = paywallCopy(refusal(reason));
  expect(copy, `paywallCopy returned null for ${reason}`).not.toBeNull();
  return copy!;
}

describe('web block copy', () => {
  it('says something different for every reason', () => {
    const headings = new Set(ALL.map((r) => blockNoticeFor(r).heading));
    expect(headings.size).toBe(ALL.length);

    // The design doc calls trial-ended and subscription-ended two different
    // moments. Sharing one string across them is the shortcut this guards.
    const trial = blockNoticeFor('trial_over');
    const sub = blockNoticeFor('subscription_over');
    expect(trial.body.join(' ')).not.toBe(sub.body.join(' '));
  });

  it('never accuses the user when the cap fires', () => {
    const text = [blockNoticeFor('usage_cap').heading, ...blockNoticeFor('usage_cap').body]
      .join(' ')
      .toLowerCase();
    for (const accusation of ['exceeded', 'too much', 'abuse', 'limit reached', 'violation']) {
      expect(text).not.toContain(accusation);
    }
    // It has to point somewhere a human answers.
    expect(blockNoticeFor('usage_cap').action.href).toBe(`mailto:${SUPPORT_EMAIL}`);
  });

  it('sells on the two states that can be fixed by subscribing', () => {
    expect(blockNoticeFor('trial_over').tone).toBe('sell');
    expect(blockNoticeFor('subscription_over').tone).toBe('sell');
    expect(blockNoticeFor('usage_cap').tone).toBe('apologise');
    expect(blockNoticeFor('revoked').tone).toBe('apologise');
  });

  /**
   * The suspension copy is the one joke in the paywall, and these two tests are
   * the reason it is allowed to be one.
   *
   * A gag is a liability in a refusal message: it is the part a rewrite keeps
   * and the facts are the part it loses. So the joke itself is NOT pinned —
   * "balls in the river" may become something else entirely — while the two
   * things a locked-out person actually needs are: that the suspension is
   * temporary, and that support is where it gets undone. Lose either and the
   * message is worse than the bank letter it replaced.
   */
  it('says temporarily suspended and points at support, joke or no joke', () => {
    const notice = blockNoticeFor('revoked');
    const web = [notice.heading, ...notice.body].join(' ').toLowerCase();
    expect(web).toContain('temporarily suspended');
    expect(notice.action.href).toBe(`mailto:${SUPPORT_EMAIL}`);

    // Penny's own version, which is what the phone renders. Same two facts.
    const penny = pennyCopyFor('revoked');
    expect(penny.message.toLowerCase()).toContain('temporarily suspended');
    expect(penny.message.toLowerCase()).toContain('support');
    expect(penny.buttonLabel).toBe('Email support');

    // The overlay's hardcoded "Planning is paused" is wrong for a suspension —
    // it is not a pause — so this is the one reason that sends its own
    // heading. Absent everywhere else, by design: see PaywallCopy.heading.
    expect(penny.heading).toBeTruthy();
  });

  it('never lets the cap borrow the joke', () => {
    /**
     * `usage_cap` fires when OUR per-trip cost regressed. A joke about
     * somebody's account at that moment reads as blaming them for our bug, so
     * these two reasons must never converge — which is the whole reason
     * `BlockReason` is a field separate from `AccountState`.
     */
    const cap = blockNoticeFor('usage_cap');
    const capText = [cap.eyebrow, cap.heading, ...cap.body, pennyCopyFor('usage_cap').message]
      .join(' ')
      .toLowerCase();
    for (const word of ['ball', 'river', 'suspend', 'fetch']) {
      expect(capText, `usage_cap must not say "${word}"`).not.toContain(word);
    }
    expect(pennyCopyFor('usage_cap').heading).toBeUndefined();

    // And all four still say four different things, in both surfaces.
    const pennyMessages = new Set(ALL.map((r) => pennyCopyFor(r).message));
    expect(pennyMessages.size).toBe(ALL.length);
  });

  it('does not promise readable trips in the one state where they are gone', () => {
    // `refunded` / `revoked` set canViewExistingTrips=false. Copy claiming the
    // itinerary is still there would be a lie the page itself contradicts.
    const text = blockNoticeFor('revoked').body.join(' ').toLowerCase();
    expect(text).not.toContain('stay readable');
    expect(text).toContain('unavailable');
  });
});

/**
 * The one word the paywall does not say.
 *
 * The owner's call, and the reason this is a test rather than a note in a doc:
 * copy gets reworded, and "subscribe" is the word every draft reaches for
 * first. The user reads "plan" — pick a plan, your plan, keep planning.
 *
 * Scoped to what a user READS. `BlockReason` is still `subscription_over`, the
 * table is still `subscriptions`, and renaming those would cost every reader of
 * the payments module something for no user's benefit.
 */
describe('user-facing copy never says the s-word', () => {
  const BANNED = ['subscribe', 'subscription', 'subscriber'];

  /** Every string either surface hands a user, from both copy modules. */
  function everythingAUserReads(): string[] {
    // The App Store button's label is not reachable through any BlockNotice —
    // it is the purchase sheet's own string — so it has to be swept explicitly
    // or the one button that leaves the web is the one place the word could
    // come back unnoticed.
    const out: string[] = [APP_STORE_CTA_LABEL];
    for (const reason of ALL) {
      const notice = blockNoticeFor(reason);
      out.push(notice.eyebrow, notice.heading, notice.action.label, ...notice.body);

      const penny = pennyCopyFor(reason);
      // `heading` is optional and absent on three of the four, so it is pushed
      // conditionally rather than as an empty string — an empty string would
      // pass this sweep whether the field existed or not.
      out.push(penny.message, penny.buttonLabel);
      if (penny.heading) out.push(penny.heading);
    }
    for (let days = 0; days <= 7; days += 1) out.push(trialWelcomeLine(days));
    return out;
  }

  it('holds across every block reason, on the web notice and in Penny\'s bubble', () => {
    for (const line of everythingAUserReads()) {
      for (const word of BANNED) {
        expect(line.toLowerCase()).not.toContain(word);
      }
    }
  });

  it('says what the one button that leaves the web does', () => {
    // "Continue" on its own reads as "continue in this browser", which is the
    // single thing the web cannot do with a purchase. There is no plan to pick
    // until the app is on the phone, so the button says the only thing the web
    // can offer: the download.
    expect(APP_STORE_CTA_LABEL).toBe('Download the app');
  });

  it('still names both prices — dropping the word must not drop the offer', () => {
    const sales = [
      blockNoticeFor('trial_over').body.join(' '),
      paywallCopy(refusal('trial_over'))!.message,
    ];
    for (const text of sales) {
      expect(text).toContain('$2');
      expect(text).toContain('$20');
    }
  });
});
