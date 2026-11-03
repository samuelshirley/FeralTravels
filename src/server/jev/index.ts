import 'server-only';

import type { MessageTier } from '@/lib/pennyGate';
import type { ClassifyContext } from '@/lib/pennyClassifierPrompt';

import type { JevRoute } from '@/lib/jevRoute';
import type { TypeSafeConsentProof } from '@/server/aiConsent';

import { postSystemOne, type FetchLike, type JevCallResult } from './client';
import { readJevConfig, type JevConfig, type JevConfigResult } from './config';
import { MIN_MARGIN, settlesAsT1 } from './decide';
import {
  buildCompareRequest,
  buildTierRequest,
  ROUTE_LABELS,
  ROUTE_QUESTION_KEY,
  TIER_LABELS,
  TIER_QUESTION_KEY,
  type SystemOneRequest,
} from './question';
import { readChoiceAnswer } from './schema';

/**
 * Jev — a typed-decision model asked the message gate's tier question first.
 *
 * A BOUNDED MODULE, like `payments/`: this file is the only public surface and
 * `jevBoundaryGuard.test.ts` holds the list of who may import it (the gate, its
 * repo, the admin routes, scripts). The internals are small, but the property
 * worth protecting is that exactly one place in the app can ask Jev anything:
 * the message gate. It asks the TIER question, and — in compare mode only,
 * logged and never acted on — the ROUTE question (`src/lib/jevRoute.ts`).
 *
 * `jevClassifyTier()` NEVER THROWS and never decides anything but "T1, settled"
 * or "not settled". The caller sends every unsettled message to Haiku.
 *
 * Every function that sends demands a `TypeSafeConsentProof` for the user:
 * a message reaches TypeSafe only for an account that agreed to the consent
 * sheet that names it. See `docs/design/jev.md`.
 */

export type { JevConfigResult } from './config';
export { MIN_MARGIN } from './decide';

/** Why Jev did not settle a message. `null` when it did. */
export type JevDeferredReason =
  | 'not_configured'
  | 'timeout'
  | 'network'
  | 'bad_json'
  | 'schema'
  | 'not_t1'
  | 'below_t1_min'
  | 'margin'
  | 'threw'
  | `http_${number}`;

export interface JevTierOutcome {
  /** True only for a confident T1. */
  settled: boolean;
  choice: MessageTier | null;
  top: number | null;
  margin: number | null;
  latencyMs: number | null;
  deferredReason: JevDeferredReason | null;
  echoedModel: string | null;
  inputTokens: number;
  outputTokens: number;
  /** False when no usable answer came back (error, timeout, schema, config). */
  success: boolean;
  /** Short and free of user text; for `usage_events.error_message`. */
  errorMessage: string | null;
}

/** The config as /admin shows it: configured or the reason it is not. */
export function jevConfigStatus(env?: Record<string, string | undefined>): JevConfigResult {
  return readJevConfig(env);
}

function unsettled(
  deferredReason: JevDeferredReason,
  rest: Partial<JevTierOutcome> = {}
): JevTierOutcome {
  return {
    settled: false,
    choice: null,
    top: null,
    margin: null,
    latencyMs: null,
    echoedModel: null,
    inputTokens: 0,
    outputTokens: 0,
    success: false,
    errorMessage: null,
    ...rest,
    deferredReason,
  };
}

/** Why a Jev call produced no usable answer, from the client's result. */
function callFailure(call: Extract<JevCallResult, { ok: false }>): JevDeferredReason {
  return call.kind === 'http' ? `http_${call.status ?? 0}` : call.kind;
}

/** Top ≥ the config's threshold AND top minus second ≥ MIN_MARGIN — the bar Jev-first uses. */
function isConfident(top: number, margin: number, t1Min: number): boolean {
  return top >= t1Min && margin >= MIN_MARGIN;
}

async function send(
  config: JevConfig,
  request: SystemOneRequest,
  consent: TypeSafeConsentProof,
  userId: string,
  fetchImpl: FetchLike | undefined
): Promise<JevCallResult> {
  return postSystemOne(config, request, consent, userId, fetchImpl);
}

export async function jevClassifyTier(
  message: string,
  ctx: ClassifyContext,
  consent: TypeSafeConsentProof,
  userId: string,
  deps: { fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {}
): Promise<JevTierOutcome> {
  try {
    const cfg = readJevConfig(deps.env);
    if (!cfg.ok) {
      return unsettled('not_configured', { errorMessage: `not configured: ${cfg.reason}` });
    }
    const { config } = cfg;

    const call = await send(config, buildTierRequest(message, ctx, config.model), consent, userId, deps.fetchImpl);
    if (!call.ok) {
      return unsettled(callFailure(call), { latencyMs: call.latencyMs, errorMessage: call.message });
    }
    return readTier(call.body, call.latencyMs, config);
  } catch (err) {
    console.error('[jev] classify threw; deferring to Haiku', err);
    return unsettled('threw', {
      errorMessage: (err instanceof Error ? err.name : 'threw').slice(0, 80),
    });
  }
}

function readTier(body: unknown, latencyMs: number, config: JevConfig): JevTierOutcome {
  const parsed = readChoiceAnswer(body, TIER_QUESTION_KEY, TIER_LABELS);
  if (!parsed.ok) {
    return unsettled('schema', {
      latencyMs,
      echoedModel: parsed.echoedModel,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      errorMessage: `schema: ${parsed.reason}`,
    });
  }
  const r = parsed.reading;
  const verdict = settlesAsT1(r, config.t1Min);
  return {
    settled: verdict.settled,
    choice: r.choice,
    top: r.top,
    margin: r.margin,
    latencyMs,
    deferredReason: verdict.settled ? null : verdict.reason,
    echoedModel: r.echoedModel,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    success: true,
    errorMessage: null,
  };
}

// ── Compare mode ────────────────────────────────────────────────────────────

/** Jev's answer to the route question. Logged; nothing acts on it. */
export interface JevRouteReading {
  choice: JevRoute | null;
  top: number | null;
  margin: number | null;
  /** Clears the same bar Jev-first sets for a T1 (`JEV_T1_MIN`, `MIN_MARGIN`). */
  confident: boolean;
  /** Short, free of user text; null when the route was read. */
  error: string | null;
}

/**
 * One compare-mode call: the route answer always, the tier answer when the
 * tier was asked. The call-level facts (latency, tokens, model, success) live
 * on `tier` when it was asked and are repeated on `call` either way.
 */
export interface JevCompareOutcome {
  /** Null when the tier question was not asked (a message the free rules let through). */
  tier: JevTierOutcome | null;
  /** The tier answer cleared Jev-first's bar (`top ≥ JEV_T1_MIN`, margin ≥ MIN_MARGIN), whatever the tier. */
  tierConfident: boolean;
  route: JevRouteReading;
  call: {
    latencyMs: number | null;
    inputTokens: number;
    outputTokens: number;
    echoedModel: string | null;
    /** Every question asked came back readable. */
    success: boolean;
    /** Why not, short and free of user text. */
    errorMessage: string | null;
    deferredReason: JevDeferredReason | null;
  };
}

function failedCompare(
  askTier: boolean,
  reason: JevDeferredReason,
  rest: { latencyMs?: number | null; errorMessage: string }
): JevCompareOutcome {
  const latencyMs = rest.latencyMs ?? null;
  return {
    tier: askTier ? unsettled(reason, { latencyMs, errorMessage: rest.errorMessage }) : null,
    tierConfident: false,
    route: { choice: null, top: null, margin: null, confident: false, error: rest.errorMessage },
    call: {
      latencyMs,
      inputTokens: 0,
      outputTokens: 0,
      echoedModel: null,
      success: false,
      errorMessage: rest.errorMessage,
      deferredReason: reason,
    },
  };
}

async function jevCompare(
  message: string,
  ctx: ClassifyContext,
  consent: TypeSafeConsentProof,
  userId: string,
  askTier: boolean,
  deps: { fetchImpl?: FetchLike; env?: Record<string, string | undefined> }
): Promise<JevCompareOutcome> {
  try {
    const cfg = readJevConfig(deps.env);
    if (!cfg.ok) return failedCompare(askTier, 'not_configured', { errorMessage: `not configured: ${cfg.reason}` });
    const { config } = cfg;

    const call = await send(
      config,
      buildCompareRequest(message, ctx, config.model, { tier: askTier }),
      consent,
      userId,
      deps.fetchImpl
    );
    if (!call.ok) {
      return failedCompare(askTier, callFailure(call), { latencyMs: call.latencyMs, errorMessage: call.message });
    }

    const tier = askTier ? readTier(call.body, call.latencyMs, config) : null;
    const tierConfident =
      tier !== null && tier.top !== null && tier.margin !== null && isConfident(tier.top, tier.margin, config.t1Min);

    const parsed = readChoiceAnswer(call.body, ROUTE_QUESTION_KEY, ROUTE_LABELS);
    const route: JevRouteReading = parsed.ok
      ? {
          choice: parsed.reading.choice,
          top: parsed.reading.top,
          margin: parsed.reading.margin,
          confident: isConfident(parsed.reading.top, parsed.reading.margin, config.t1Min),
          error: null,
        }
      : { choice: null, top: null, margin: null, confident: false, error: `schema: route: ${parsed.reason}` };

    // The usage block is the same for every question in the body; read it once.
    const any = parsed.ok ? parsed.reading : parsed;
    const tierError = tier && !tier.success ? `tier: ${tier.errorMessage ?? 'unreadable'}` : null;
    const errors = [tierError, route.error].filter((e): e is string => e !== null);
    return {
      tier,
      tierConfident,
      route,
      call: {
        latencyMs: call.latencyMs,
        inputTokens: any.inputTokens,
        outputTokens: any.outputTokens,
        echoedModel: any.echoedModel,
        success: errors.length === 0,
        errorMessage: errors.length ? errors.join('; ').slice(0, 200) : null,
        deferredReason: errors.length ? 'schema' : null,
      },
    };
  } catch (err) {
    console.error('[jev] compare threw; Haiku decides as always', err);
    return failedCompare(askTier, 'threw', {
      errorMessage: (err instanceof Error ? err.name : 'threw').slice(0, 80),
    });
  }
}

/**
 * Compare mode: START Jev's answer now, read it later — and never wait past
 * Jev's own timeout, counted from now.
 *
 * ONE request carrying the route question and, when `askTier`, the tier
 * question — so the second question costs a few criteria tokens, not a second
 * call. The fetch goes out before this returns, so the caller can ask Haiku in
 * the meantime and pay only for whatever of Jev's timeout is left once Haiku
 * has answered. The client's AbortController already bounds the exchange; the
 * deadline here bounds the WAIT as well, so a backend (or a fetch) that
 * ignores the abort still costs the driver no more than `JEV_TIMEOUT_MS`.
 * The reader never throws.
 */
export function startJevCompare(
  message: string,
  ctx: ClassifyContext,
  consent: TypeSafeConsentProof,
  userId: string,
  opts: { askTier: boolean },
  deps: {
    fetchImpl?: FetchLike;
    env?: Record<string, string | undefined>;
    clock?: () => number;
  } = {}
): () => Promise<JevCompareOutcome> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  let budgetMs = 0;
  try {
    const cfg = readJevConfig(deps.env);
    budgetMs = cfg.ok ? cfg.config.timeoutMs : 0;
  } catch (err) {
    console.error('[jev] could not read the config for the compare deadline', err);
  }
  const pending = jevCompare(message, ctx, consent, userId, opts.askTier, deps);

  return async () => {
    const left = Math.max(0, budgetMs - (clock() - started));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<JevCompareOutcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve(
            failedCompare(opts.askTier, 'timeout', {
              latencyMs: clock() - started,
              errorMessage: `no answer within ${budgetMs} ms`,
            })
          ),
        left
      );
    });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}
