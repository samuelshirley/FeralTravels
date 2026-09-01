import { describe, it, expect } from 'vitest';
import {
  MANAGE_SUBSCRIPTIONS_URL,
  PURCHASE_CONFIRMING_MESSAGE,
  PURCHASE_CONFIRM_TIMEOUT_MESSAGE,
  purchaseOutcomeMessage,
  restoreOutcomeMessage,
  type PurchaseFailureReason,
  type PurchaseOutcome,
  type RestoreOutcome,
} from './purchaseOutcome';

/**
 * Same shape of guard as `promoCopy.test.ts` and `paywallCopy.test.ts`, for the
 * same reason: TypeScript already forces the switch to be exhaustive, so what
 * is worth asserting is what a type cannot — that these are actually different
 * messages, and that the two which are NOT failures do not read like failures.
 *
 * This matters more here than for a promo code. The reader of most of these
 * strings has just been charged money.
 */
const FAILURES: PurchaseFailureReason[] = [
  'network',
  'store',
  'not_allowed',
  'payment_invalid',
  'unavailable',
  'misconfigured',
  'unknown',
];

describe('purchaseOutcomeMessage', () => {
  it('says nothing for a purchase or a cancellation', () => {
    // A completed purchase is followed by the waiting state, not by a
    // congratulation. A cancellation is the user closing a sheet they opened —
    // narrating it back to them is noise, and "purchase cancelled" in red reads
    // as a failure they should worry about.
    expect(purchaseOutcomeMessage({ kind: 'purchased', productId: 'x' })).toBeNull();
    expect(purchaseOutcomeMessage({ kind: 'cancelled' })).toBeNull();
  });

  it('has a distinct message for every failure reason', () => {
    const messages = FAILURES.map((reason) =>
      purchaseOutcomeMessage({ kind: 'failed', reason })
    );
    for (const [i, m] of messages.entries()) {
      expect(m?.trim(), FAILURES[i]).toBeTruthy();
    }
    expect(new Set(messages).size).toBe(FAILURES.length);
  });

  it('tells a deferred purchase that nothing is wrong and nothing is charged', () => {
    /**
     * Ask to Buy is the one outcome most likely to be mistaken for a failure by
     * whoever wrote the code AND by whoever reads the message. RevenueCat
     * reports it as PAYMENT_PENDING_ERROR — an *error* code for a state that is
     * working exactly as designed — so the copy has to carry the correction.
     */
    const copy = purchaseOutcomeMessage({ kind: 'pending' })?.toLowerCase() ?? '';
    expect(copy).toContain('approval');
    expect(copy).toContain('nothing is charged');
    for (const alarm of ['failed', 'error', 'went wrong', 'try again']) {
      expect(copy, alarm).not.toContain(alarm);
    }
  });

  it('points an already-owned purchase at Restore rather than at another charge', () => {
    const copy = purchaseOutcomeMessage({ kind: 'already_owned' })?.toLowerCase() ?? '';
    expect(copy).toContain('restore');
    // The single fear this message exists to answer.
    expect(copy).toContain('charged twice');
  });

  it('never blames the reader for a failure that is ours or Apple\'s', () => {
    /**
     * `unavailable` and `misconfigured` are both OUR paperwork — an empty
     * offering means the Paid Applications Agreement, a product in Missing
     * Metadata, or a wrong RevenueCat key. Every one of those reaches the user
     * as "you did something wrong" unless the copy says otherwise.
     */
    for (const reason of ['unavailable', 'misconfigured'] as const) {
      const copy = purchaseOutcomeMessage({ kind: 'failed', reason })?.toLowerCase() ?? '';
      expect(copy, reason).toMatch(/on us|our bug/);
    }
    for (const reason of FAILURES) {
      const copy = purchaseOutcomeMessage({ kind: 'failed', reason })?.toLowerCase() ?? '';
      for (const accusation of ['invalid', 'you must', 'not permitted', 'denied']) {
        expect(copy, `${reason}: ${accusation}`).not.toContain(accusation);
      }
    }
  });

  it('reassures on every failure that no money moved', () => {
    // The three failures a user can act on all happen mid-sheet, where "did
    // that charge me?" is the first question. Only the ones where Apple might
    // genuinely have taken something are exempt — and there are none: a failed
    // purchase never charges.
    for (const reason of ['network', 'store', 'unknown'] as const) {
      const copy = purchaseOutcomeMessage({ kind: 'failed', reason })?.toLowerCase() ?? '';
      expect(copy, reason).toContain('charged');
    }
  });
});

describe('restoreOutcomeMessage', () => {
  it('says nothing when the restore worked', () => {
    expect(restoreOutcomeMessage({ kind: 'restored' })).toBeNull();
  });

  it('treats an empty restore as information, not as a failure', () => {
    /**
     * The commonest reason for this is a second Apple ID, and the user cannot
     * guess that. A bare "nothing to restore" leaves them tapping the same
     * button; naming the Apple ID is the whole value of the message.
     */
    const copy = restoreOutcomeMessage({ kind: 'nothing_to_restore' })?.toLowerCase() ?? '';
    expect(copy).toContain('apple id');
    expect(copy).not.toContain('error');
  });

  it('reuses the purchase failure copy so the two cannot drift', () => {
    for (const reason of FAILURES) {
      expect(restoreOutcomeMessage({ kind: 'failed', reason })).toBe(
        purchaseOutcomeMessage({ kind: 'failed', reason })
      );
    }
  });
});

describe('the waiting copy', () => {
  it('leads with the money on both messages', () => {
    /**
     * Both are read by somebody who has just watched Apple confirm a charge.
     * Anything that reads like "processing your purchase…" invites a second
     * attempt, which is the one outcome worse than a slow one.
     */
    expect(PURCHASE_CONFIRMING_MESSAGE.toLowerCase()).toContain('payment received');
    const timeout = PURCHASE_CONFIRM_TIMEOUT_MESSAGE.toLowerCase();
    expect(timeout).toContain('went through');
    expect(timeout).toContain('not been charged twice');
    // It must offer the two recoveries, not just apologise.
    expect(timeout).toContain('reopen the app');
    expect(timeout).toContain('restore purchases');
  });

  it('never tells a paying user something failed', () => {
    const timeout = PURCHASE_CONFIRM_TIMEOUT_MESSAGE.toLowerCase();
    for (const alarm of ['failed', 'error', 'went wrong', 'could not']) {
      expect(timeout, alarm).not.toContain(alarm);
    }
  });
});

describe('MANAGE_SUBSCRIPTIONS_URL', () => {
  it('is the itms-apps deep link Apple documents, not the https bounce', () => {
    // The https://apps.apple.com form opens the App Store and can land on the
    // account root rather than the subscription list. Guideline 3.1.2 wants the
    // user able to reach the management screen; "somewhere near it" is not it.
    expect(MANAGE_SUBSCRIPTIONS_URL).toBe('itms-apps://apps.apple.com/account/subscriptions');
  });
});

/** Compile-time proof the unions still cover what the app branches on. */
const _exhaustive: [PurchaseOutcome['kind'][], RestoreOutcome['kind'][]] = [
  ['purchased', 'cancelled', 'pending', 'already_owned', 'failed'],
  ['restored', 'nothing_to_restore', 'failed'],
];
void _exhaustive;
