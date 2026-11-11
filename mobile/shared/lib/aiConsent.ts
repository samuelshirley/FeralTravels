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
 * The consent sheet's version. Bump it when the sheet starts naming a new
 * recipient or a new kind of data, and the server re-asks every account that
 * agreed to an older one (`users.ai_consent_version`, `src/server/aiConsent.ts`).
 *
 *   1 — Anthropic only (2026-10-20).
 *   2 — Anthropic, and TypeSafe for sorting messages (2026-11-03).
 *
 * An account on an older version keeps what it agreed to: Penny still works
 * for it, and nothing newer is sent until it agrees to the newer sheet.
 */
export const AI_CONSENT_VERSION = 2 as const;

/** The first version whose sheet names TypeSafe. Below it, Jev is never called. */
export const TYPESAFE_CONSENT_VERSION = 2 as const;

/**
 * The consent sheet. Names each company, and what each one gets, because
 * naming them is the whole point of the guideline.
 *
 * "Anthropic doesn't use them to train its models" is checked, not assumed:
 * Anthropic's Commercial Terms (effective 2025-06-17), section B: "Anthropic
 * may not train models on Customer Content from Services." The app calls the
 * API under those terms. If they ever change, this sentence goes.
 *
 * TypeSafe's paragraph lists EXACTLY what `buildClassifyContent`
 * (`src/lib/pennyClassifierPrompt.ts`) puts in a request, fed by
 * `tripVocabulary` (`src/server/messageGate.ts`): the message, the trip's
 * name, up to 40 names from the trip (day titles, start and end places, stop
 * names, the vehicle's name) and the last 400 characters of Penny's previous
 * message. Not photos, not the location, not dates or distances. If that
 * function starts sending more, this sentence changes first
 * (`aiConsent.test.ts` pins the list). Its training line is TypeSafe's own
 * statement (October 2026) and is worded as one: "TypeSafe says".
 */
export const AI_CONSENT_COPY = {
  title: 'Penny uses Anthropic and TypeSafe',
  body:
    'To plan your trip, your messages, any photos you attach, your trip details and your ' +
    'current location are sent to Anthropic, which runs the Claude AI model. Anthropic ' +
    "doesn't use them to train its models.",
  typeSafeBody:
    'To sort your messages, the text of each may also be sent to TypeSafe, in the US, with ' +
    "your trip's name, its place and vehicle names, and the end of Penny's last reply. " +
    "TypeSafe says it doesn't train on them.",
  /** Above the body, only for an account that agreed to an older sheet: what changed. */
  upgradeLead: 'Penny now also uses TypeSafe.',
  privacyLink: 'Privacy Policy',
  agree: 'Agree',
  notNow: 'Not now',
  /**
   * The decline button for an account that already agreed to Anthropic: it
   * keeps Penny working on what was agreed, so it says that, rather than
   * "Not now", which reads as switching Penny off.
   */
  notNowUpgrade: 'Anthropic only',
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
 *   needed   — the server says this account has not agreed to anything
 *   upgrade  — agreed to an OLDER sheet (Anthropic only). Penny works; the
 *              current sheet is shown once per screen, at the next send, and
 *              its decline ("Anthropic only") lets the send go ahead
 *   granted  — agreed to the current sheet; stored server-side, so never
 *              asked again anywhere
 *   declined — "Not now" with nothing agreed, on this screen: Penny's
 *              composer is disabled, with a one-line way back to the sheet
 */
export type AiConsentStatus = 'unknown' | 'needed' | 'upgrade' | 'granted' | 'declined';

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
   * Resolves true once this account may send to Penny — at once if it agreed
   * to the current sheet, else after Agree is tapped AND the server stored
   * it. False on Not now with nothing agreed. An account on an older sheet
   * resolves true either way: it is asked once, and its decline keeps what
   * it agreed to. Every send to Penny awaits this first.
   */
  ensure(): Promise<boolean>;
  open(): void;
  agree(): Promise<void>;
  notNow(): void;
  /** The server answered 403 `ai_consent_required`: back to asking. */
  requiredByServer(): void;
}

/** Which status a stored version means. `null` = never agreed. */
export function statusForVersion(version: number | null): AiConsentStatus {
  if (version === null || !(version >= 1)) return 'needed';
  return version >= AI_CONSENT_VERSION ? 'granted' : 'upgrade';
}

export function createAiConsentController(deps: {
  /**
   * The newest sheet version this account agreed to (`GET /api/me`'s
   * `ai_consent_version`), null if none; throws when it cannot tell.
   */
  fetchConsent: () => Promise<number | null>;
  /**
   * `PATCH /api/me/preferences { ai_consent: true, ai_consent_version:
   * AI_CONSENT_VERSION }`; throws on failure.
   */
  saveConsent: () => Promise<void>;
  onChange: (snapshot: AiConsentSnapshot) => void;
}): AiConsentController {
  let state: AiConsentSnapshot = { status: 'unknown', sheetOpen: false, saving: false, error: null };
  let waiting: Array<(agreed: boolean) => void> = [];
  /** An `upgrade` account is shown the newer sheet once per screen, not per send. */
  let upgradeAsked = false;

  const set = (patch: Partial<AiConsentSnapshot>) => {
    state = { ...state, ...patch };
    deps.onChange(state);
  };
  const settle = (agreed: boolean) => {
    const resolvers = waiting;
    waiting = [];
    for (const resolve of resolvers) resolve(agreed);
  };
  /** The status the server's answer means, or null when it could not answer. */
  const ask = async (): Promise<AiConsentStatus | null> => {
    try {
      return statusForVersion(await deps.fetchConsent());
    } catch {
      // Not swallowed: an unanswered question is treated as "not agreed", so
      // the worst case is the sheet for someone who already agreed — and
      // agreeing again is idempotent server-side.
      return null;
    }
  };
  const open = () => set({ sheetOpen: true, error: null });
  /** Read through a function so TypeScript does not narrow it across an await. */
  const current = (): AiConsentStatus => state.status;
  const wait = () =>
    new Promise<boolean>((resolve) => {
      waiting.push(resolve);
      open();
    });

  return {
    get: () => state,
    async load() {
      const status = await ask();
      if (status === null || state.status !== 'unknown') return;
      set({ status });
    },
    async ensure() {
      if (state.status === 'granted') return true;
      if (state.status === 'unknown') {
        const status = await ask();
        // `load()` may have answered while this was asking; the first answer stands.
        if (status !== null && current() === 'unknown') set({ status });
        if (current() === 'granted') return true;
      }
      if (state.status === 'upgrade') {
        if (upgradeAsked) return true;
        upgradeAsked = true;
      }
      return wait();
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
      if (state.status === 'upgrade') {
        // They keep what they agreed to: the send goes ahead, Anthropic only.
        upgradeAsked = true;
        set({ sheetOpen: false, error: null });
        settle(true);
        return;
      }
      set({ status: 'declined', sheetOpen: false, error: null });
      settle(false);
    },
    requiredByServer() {
      set({ status: 'declined' });
      open();
    },
  };
}

/**
 * The agreed version out of `GET /api/me`. A server from before versioning
 * sends only `ai_consent: true`, which can only mean version 1 — the sheet it
 * knew. Shared by both hooks so they cannot read it two ways.
 */
export function consentVersionFromMe(me: { ai_consent?: boolean; ai_consent_version?: number | null }): number | null {
  if (typeof me.ai_consent_version === 'number' && me.ai_consent_version >= 1) return me.ai_consent_version;
  return me.ai_consent === true ? 1 : null;
}
