import 'server-only';

import type { MessageTier } from '@/lib/pennyGate';
import type { ClassifyContext } from '@/lib/pennyClassifierPrompt';

import { postSystemOne, type FetchLike } from './client';
import { readJevConfig, type JevConfigResult } from './config';
import { settlesAsT1 } from './decide';
import { buildTierRequest, TIER_LABELS, TIER_QUESTION_KEY } from './question';
import { readChoiceAnswer } from './schema';

/**
 * Jev — a typed-decision model asked the message gate's tier question first.
 *
 * A BOUNDED MODULE, like `payments/`: this file is the only public surface and
 * `jevBoundaryGuard.test.ts` holds the list of who may import it (the gate, its
 * repo, the admin routes, scripts). The internals are small, but the property
 * worth protecting is that exactly one place in the app can ask Jev anything,
 * and it can only ask this one question.
 *
 * `jevClassifyTier()` NEVER THROWS and never decides anything but "T1, settled"
 * or "not settled". The caller sends every unsettled message to Haiku.
 * See `docs/design/jev.md`.
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

export async function jevClassifyTier(
  message: string,
  ctx: ClassifyContext,
  deps: { fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {}
): Promise<JevTierOutcome> {
  try {
    const cfg = readJevConfig(deps.env);
    if (!cfg.ok) {
      return unsettled('not_configured', { errorMessage: `not configured: ${cfg.reason}` });
    }
    const { config } = cfg;

    const call = await postSystemOne(
      config,
      buildTierRequest(message, ctx, config.model),
      deps.fetchImpl
    );
    if (!call.ok) {
      const reason: JevDeferredReason =
        call.kind === 'http' ? `http_${call.status ?? 0}` : call.kind;
      return unsettled(reason, { latencyMs: call.latencyMs, errorMessage: call.message });
    }

    const parsed = readChoiceAnswer(call.body, TIER_QUESTION_KEY, TIER_LABELS);
    if (!parsed.ok) {
      return unsettled('schema', {
        latencyMs: call.latencyMs,
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
      latencyMs: call.latencyMs,
      deferredReason: verdict.settled ? null : verdict.reason,
      echoedModel: r.echoedModel,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      success: true,
      errorMessage: null,
    };
  } catch (err) {
    console.error('[jev] classify threw; deferring to Haiku', err);
    return unsettled('threw', {
      errorMessage: (err instanceof Error ? err.name : 'threw').slice(0, 80),
    });
  }
}

/**
 * Compare mode: START Jev's answer now, read it later — and never wait past
 * Jev's own timeout, counted from now.
 *
 * The fetch goes out before this returns, so the caller can ask Haiku in the
 * meantime and pay only for whatever of Jev's timeout is left once Haiku has
 * answered. The client's AbortController already bounds the exchange; the
 * deadline here bounds the WAIT as well, so a backend (or a fetch) that
 * ignores the abort still costs the driver no more than `JEV_TIMEOUT_MS`.
 * Like `jevClassifyTier`, the reader never throws.
 */
export function startJevClassifyTier(
  message: string,
  ctx: ClassifyContext,
  deps: {
    fetchImpl?: FetchLike;
    env?: Record<string, string | undefined>;
    clock?: () => number;
  } = {}
): () => Promise<JevTierOutcome> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  let budgetMs = 0;
  try {
    const cfg = readJevConfig(deps.env);
    budgetMs = cfg.ok ? cfg.config.timeoutMs : 0;
  } catch (err) {
    console.error('[jev] could not read the config for the compare deadline', err);
  }
  const pending = jevClassifyTier(message, ctx, deps);

  return async () => {
    const left = Math.max(0, budgetMs - (clock() - started));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<JevTierOutcome>((resolve) => {
      timer = setTimeout(
        () =>
          resolve(
            unsettled('timeout', {
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
