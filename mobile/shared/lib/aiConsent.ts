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

/**
 * The consent sheet's state machine, shared by both panels (each wraps it in
 * a small React hook: `src/components/useAiConsent.ts`,
 * `mobile/lib/useAiConsent.ts`). Pure — the two network calls are injected —
 * so the root vitest project tests the logic the phone runs.
 *
 *   unknown  — not asked the server yet
 *   needed   — the server says this account has not agreed
 *   granted  — agreed; stored server-side, so never asked again anywhere
 *   declined — "Not now" on this screen: Penny's composer is disabled, with a
 *              one-line way back to the sheet
 */
export type AiConsentStatus = 'unknown' | 'needed' | 'granted' | 'declined';

export interface AiConsentSnapshot {
  status: AiConsentStatus;
  sheetOpen: boolean;
  saving: boolean;
  error: string | null;
}

export interface AiConsentController {
  get(): AiConsentSnapshot;
  /** Read the server's answer once; a failure leaves the status `unknown`. */
  load(): Promise<void>;
  /**
   * Resolves true once this account has agreed — at once if known, else after
   * Agree is tapped AND the server stored it. False on Not now. Every send to
   * Penny awaits this first.
   */
  ensure(): Promise<boolean>;
  open(): void;
  agree(): Promise<void>;
  notNow(): void;
  /** The server answered 403 `ai_consent_required`: back to asking. */
  requiredByServer(): void;
}

export function createAiConsentController(deps: {
  /** True/false from `GET /api/me`'s `ai_consent`; throws when it cannot tell. */
  fetchConsent: () => Promise<boolean>;
  /** `PATCH /api/me/preferences { ai_consent: true }`; throws on failure. */
  saveConsent: () => Promise<void>;
  onChange: (snapshot: AiConsentSnapshot) => void;
}): AiConsentController {
  let state: AiConsentSnapshot = { status: 'unknown', sheetOpen: false, saving: false, error: null };
  let waiting: Array<(agreed: boolean) => void> = [];

  const set = (patch: Partial<AiConsentSnapshot>) => {
    state = { ...state, ...patch };
    deps.onChange(state);
  };
  const settle = (agreed: boolean) => {
    const resolvers = waiting;
    waiting = [];
    for (const resolve of resolvers) resolve(agreed);
  };
  /** Null when the server could not answer: the sheet then asks instead. */
  const ask = async (): Promise<boolean | null> => {
    try {
      return await deps.fetchConsent();
    } catch {
      // Not swallowed: an unanswered question is treated as "not agreed", so
      // the worst case is the sheet for someone who already agreed — and
      // agreeing again is idempotent server-side.
      return null;
    }
  };
  const open = () => set({ sheetOpen: true, error: null });

  return {
    get: () => state,
    async load() {
      const agreed = await ask();
      if (agreed === null || state.status !== 'unknown') return;
      set({ status: agreed ? 'granted' : 'needed' });
    },
    async ensure() {
      if (state.status === 'granted') return true;
      if (state.status === 'unknown') {
        const agreed = await ask();
        if (agreed) {
          set({ status: 'granted' });
          return true;
        }
      }
      return new Promise<boolean>((resolve) => {
        waiting.push(resolve);
        open();
      });
    },
    open,
    async agree() {
      if (state.saving) return;
      set({ saving: true, error: null });
      try {
        await deps.saveConsent();
      } catch {
        // Shown in the sheet, which stays open so Agree can be retried.
        set({ saving: false, error: AI_CONSENT_COPY.saveFailed });
        return;
      }
      set({ status: 'granted', sheetOpen: false, saving: false, error: null });
      settle(true);
    },
    notNow() {
      if (state.saving) return;
      set({ status: 'declined', sheetOpen: false, error: null });
      settle(false);
    },
    requiredByServer() {
      set({ status: 'declined' });
      open();
    },
  };
}
