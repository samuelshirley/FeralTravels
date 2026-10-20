/**
 * Asking before anything reaches a third-party AI — App Review guideline
 * 5.1.2(i) as revised by Apple on 2026-10-16: "clearly disclose where personal
 * data will be shared with third parties, including with third-party AI, and
 * obtain explicit permission before doing so."
 *
 * Shared by the server, the web panel and the native panel (mirrored into
 * `mobile/shared/` by `scripts/sync-shared.mjs`), because the code the server
 * refuses with and the copy both clients show for it must have exactly one
 * definition — the argument `paywallCopy` and `promoCopy` travel under.
 *
 * The enforcement is server-side (`src/server/aiConsent.ts`): the sheet is
 * the way to say yes, never the thing that stops a request.
 */

/**
 * The `code` on a 403 from any route that would send the user's content to
 * Anthropic before they agreed. 403 and not 401 (the app clears the keychain
 * on 401) and not 402 (the paywall's word).
 */
export const AI_CONSENT_REQUIRED_CODE = 'ai_consent_required' as const;

/** The server's `error` string on that 403 — what a client that ignores `code` shows. */
export const AI_CONSENT_REQUIRED_MESSAGE =
  "Penny needs your OK before your messages are sent to Anthropic's Claude.";

/**
 * The consent sheet. Names the company, the model and every kind of data that
 * goes, because naming them is the whole point of the guideline.
 *
 * "Anthropic doesn't use them to train its models" is checked, not assumed:
 * Anthropic's Commercial Terms (effective 2025-06-17), section B: "Anthropic
 * may not train models on Customer Content from Services." The app calls the
 * API under those terms. If they ever change, this sentence goes.
 */
export const AI_CONSENT_COPY = {
  title: "Penny uses Anthropic's Claude",
  body:
    'To plan your trip, your messages, any photos you attach, your trip details and your ' +
    'current location are sent to Anthropic, which runs the Claude AI model. Anthropic ' +
    "doesn't use them to train its models.",
  privacyLink: 'Privacy Policy',
  agree: 'Agree',
  notNow: 'Not now',
  /** Under Penny's disabled composer after "Not now". The link reopens the sheet. */
  declinedLine: "Penny can't plan until you agree to send your messages to Anthropic.",
  declinedAction: 'Review',
  /** Saving the agreement failed — inline, never swallowed. */
  saveFailed: "Couldn't save that. Check your connection and try again.",
} as const;

/** Where the privacy policy lives, relative to the server's origin. */
export const PRIVACY_POLICY_PATH = '/privacy';
