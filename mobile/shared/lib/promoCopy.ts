import type { PromoRefusal } from '../lib/promoCode';

/**
 * What a refused redemption says, one message per machine code.
 *
 * Pure data, no `server-only`: the route sends it, both clients render it, and
 * the unit test reads it. Mirrored into the Expo app by `scripts/sync-shared.mjs`
 * for the reason `src/lib/nativeErrorCopyGuard.test.ts` exists — an error code
 * with no copy in a client shows the generic "Something went wrong" for a
 * failure the user could have fixed in five seconds. `TokenAlreadyUsed` already
 * shipped that way once.
 *
 * Four codes, four messages, sharing no string. Three of them are things the
 * person can act on and one is not, and a single "this code cannot be used"
 * across all four would be unhelpful in at least three ways at once.
 *
 * Tone follows `paywallCopy.ts`: the reader is being told no, at the exact
 * moment they were expecting to be let in. None of these accuse anybody of
 * anything — including `promo_wrong_account`, which is the one that fires when
 * somebody tries a code that is not theirs. It is far likelier to be a person
 * who signed in with Apple after giving us their Gmail than someone passing a
 * forwarded code around, and the copy is written for that person.
 */
export const PROMO_ERROR_COPY: Record<PromoRefusal, string> = {
  promo_not_found:
    "That code isn't one of ours — worth checking for a stray character. Codes look like FERAL-4KQP-8XZM.",

  promo_already_redeemed:
    'That code has already been used. If that was you, your access should be on — reload and it will be.',

  promo_expired: 'That code has passed its date. Send us a note and we will issue a fresh one.',

  // The Apple-relay case, in plain words. Sign in with Apple can hand us a
  // private relay address instead of the one the code was issued to, so the
  // likeliest reader of this sentence did nothing wrong at all — hence naming
  // the fix rather than the suspicion.
  promo_wrong_account:
    'That code was issued to a different email address. Sign in with the address you gave us and it will work.',
};

/** Label on the redeem control. Here so the two purchase sheets cannot drift. */
export const PROMO_CTA_LABEL = 'Redeem';

/** Placeholder in the input. Shows the shape, which halves the typos. */
export const PROMO_PLACEHOLDER = 'FERAL-XXXX-XXXX';

/** The one-line invitation above the field. */
export const PROMO_PROMPT = 'Have a code?';
