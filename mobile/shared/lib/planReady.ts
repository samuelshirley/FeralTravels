/**
 * What Penny says when the first full plan lands.
 *
 * WHY THIS IS NOT PENNY'S PROSE. The handoff turn used to end with her writing
 * the whole plan out — the route recited city by city, the trade-offs, the
 * tasks, and a closing question — several hundred words arriving in one bubble
 * after a two-to-four minute wait. Three things were wrong with that, and only
 * the third is about length:
 *
 *  1. It restated what the list and map already show, which the copy rule in
 *     CLAUDE.md exists to prevent.
 *  2. It is generated text, so the one instruction that matters — go and look
 *     at your plan — arrived in a different shape, and sometimes not at all,
 *     every single time.
 *  3. It cannot carry a control. "Head to the list view" is only useful if the
 *     list view is one tap away, and a model writing prose cannot render a
 *     button.
 *
 * So the confirmation is deterministic and the CLIENT owns its layout: the
 * words live here, in one place, and each platform draws the icon and makes
 * the list view tappable. Penny's own message is now only the honest calls she
 * made — see `<handoff_turn>` in src/lib/claude.ts.
 *
 * Mirrored to mobile/shared/lib by scripts/sync-shared.mjs.
 */

/**
 * The first line. `LIST_VIEW_WORDS` is rendered as the tappable part, so it
 * must appear in `PLAN_READY_HEADLINE` verbatim and exactly once — split on it
 * rather than hard-coding the two halves, so rewording the sentence cannot
 * silently break the link.
 */
export const LIST_VIEW_WORDS = 'list view';

export const PLAN_READY_HEADLINE = `Trip is planned — head over to the ${LIST_VIEW_WORDS}.`;

export const PLAN_READY_FOLLOW_UP =
  'Come back to me if you want any changes. I can also set a day’s destination to an exact ' +
  'place — just paste me a Google Maps link.';

/**
 * The row's stored `content`: both lines, so the transcript reads correctly
 * anywhere the structured rendering is unavailable (an old client, an admin
 * view, a database dump).
 */
export const PLAN_READY_TEXT = `${PLAN_READY_HEADLINE}\n\n${PLAN_READY_FOLLOW_UP}`;

/**
 * Split the headline around the tappable words. Returns the text before, the
 * words themselves, and the text after — so neither client has to know how the
 * sentence is worded, and a reword that drops the phrase is caught by
 * `planReady.test.ts` rather than by a link that quietly stops being one.
 */
export function planReadyHeadlineParts(): { before: string; link: string; after: string } {
  const at = PLAN_READY_HEADLINE.indexOf(LIST_VIEW_WORDS);
  if (at < 0) return { before: PLAN_READY_HEADLINE, link: '', after: '' };
  return {
    before: PLAN_READY_HEADLINE.slice(0, at),
    link: LIST_VIEW_WORDS,
    after: PLAN_READY_HEADLINE.slice(at + LIST_VIEW_WORDS.length),
  };
}
