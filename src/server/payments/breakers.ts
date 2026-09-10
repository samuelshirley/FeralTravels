/**
 * Circuit breakers — the hard ceiling on what the WHOLE app may spend.
 *
 * ── Why a global ceiling exists at all ──
 *
 * Every spend gate this app had before today was per-account: 120 replans an
 * hour, $5 of Anthropic a day, an OTP cooldown per address. Each is a sensible
 * limit on one user and none of them bounds the bill, because the attacker
 * picks the number of accounts. A hundred signed-up bots × $5/day is $500
 * overnight with every existing gate passing and nothing to see until the
 * Console updates. The owner's requirement was stated as the consequence:
 * "if someone spends five hundred dollars overnight, I have to close the
 * entire app."
 *
 * So the first defence is arithmetic rather than cleverness. The breakers cap
 * the whole deployment, so the worst case of ANY attack — one account, a
 * thousand, a shape nobody has thought of — is the cap. Everything else built
 * on top of this (per-IP limits, tiers, strikes) exists to trip it less often,
 * not to be the thing that saves us.
 *
 * ── Why this file is pure ──
 *
 * Same discipline as `states.ts`: the counts and the clock are passed IN, so
 * every threshold edge is a unit test rather than a database fixture. The DB
 * reader, the cache and the alerting live in `breakerCheck.ts`; nothing here
 * imports a database or reads a clock.
 */

/**
 * The breakers, as identifiers on the wire.
 *
 * `manual_lock` and `facts_unavailable` are in the same union as the measured
 * ones deliberately: a client, a log line and the admin panel all want ONE
 * enum for "why was this refused", and splitting the two synthetic reasons out
 * would mean every reader handling two shapes.
 */
export type BreakerId =
  | 'anthropic_spend_24h'
  | 'anthropic_spend_1h'
  | 'signups_1h'
  | 'signups_24h'
  | 'gated_messages_1h'
  | 'manual_lock'
  | 'facts_unavailable';

/**
 * `ok` — under the alert line.
 * `alert` — over the alert line, still serving. Emails the owner; nothing user-visible.
 * `open` — over the stop line. Non-admins get a 503.
 */
export type BreakerLevel = 'ok' | 'alert' | 'open';

/** What a breaker counts, which is also how the admin panel formats it. */
export type BreakerUnit = 'microcents' | 'count';

/**
 * Which gate a breaker guards.
 *
 * `penny` is anything that can reach Anthropic; `signup` is anything that can
 * mint a new account. A breaker on one must not close the other — a spend
 * flood should never stop people signing in, and a sign-up flood should never
 * stop a driver mid-trip from replanning.
 */
export type BreakerGate = 'penny' | 'signup';

export interface BreakerSpec {
  id: BreakerId;
  gate: BreakerGate;
  unit: BreakerUnit;
  /** The rolling window the fact is measured over. */
  windowHours: number;
  /** Email + admin banner at or above this. */
  alertAt: number;
  /**
   * 503 to non-admins at or above this. `null` means alert-only: the breaker
   * is a smoke detector, and something else does the stopping.
   */
  stopAt: number | null;
  /** One line for the admin panel and the alert subject. */
  label: string;
}

export interface BreakerFacts {
  anthropicMicrocents24h: number;
  anthropicMicrocents1h: number;
  signups1h: number;
  signups24h: number;
  gatedMessages1h: number;
  /** `app_meta.penny_locked` — the owner's one-tap stop. */
  manualLock: boolean;
  /**
   * True when any of the above could not be read.
   *
   * NOT a fact about the app — a fact about our knowledge of it, and it is
   * load-bearing: see `evaluateGate`, which refuses on it.
   */
  factsUnavailable: boolean;
}

export interface BreakerStatus {
  id: BreakerId;
  gate: BreakerGate;
  unit: BreakerUnit;
  level: BreakerLevel;
  /** The measured value, in `unit`. `1` for a thrown manual switch, `0` for an unthrown one. */
  value: number;
  alertAt: number;
  stopAt: number | null;
  windowHours: number;
  label: string;
}

/**
 * Level for one measured breaker.
 *
 * `>=`, not `>`, at BOTH lines, and the tests pin it. A threshold written as
 * "stop at $25" that first stops at $25.000001 is a threshold nobody can
 * assert against, and the difference has cost this repo an afternoon before.
 */
export function levelFor(value: number, alertAt: number, stopAt: number | null): BreakerLevel {
  if (stopAt !== null && value >= stopAt) return 'open';
  if (value >= alertAt) return 'alert';
  return 'ok';
}

function factFor(spec: BreakerSpec, facts: BreakerFacts): number {
  switch (spec.id) {
    case 'anthropic_spend_24h':
      return facts.anthropicMicrocents24h;
    case 'anthropic_spend_1h':
      return facts.anthropicMicrocents1h;
    case 'signups_1h':
      return facts.signups1h;
    case 'signups_24h':
      return facts.signups24h;
    case 'gated_messages_1h':
      return facts.gatedMessages1h;
    case 'manual_lock':
      return facts.manualLock ? 1 : 0;
    case 'facts_unavailable':
      return facts.factsUnavailable ? 1 : 0;
  }
}

/**
 * Every breaker's current level. Pure; order is the declaration order of
 * `thresholds`, so the admin panel renders a stable list.
 */
export function evaluateBreakers(
  facts: BreakerFacts,
  thresholds: readonly BreakerSpec[]
): BreakerStatus[] {
  return thresholds.map((spec) => {
    const value = factFor(spec, facts);
    return {
      id: spec.id,
      gate: spec.gate,
      unit: spec.unit,
      level: levelFor(value, spec.alertAt, spec.stopAt),
      value,
      alertAt: spec.alertAt,
      stopAt: spec.stopAt,
      windowHours: spec.windowHours,
      label: spec.label,
    };
  });
}

export interface GateVerdict {
  blocked: boolean;
  /** The breaker that did it. Null when nothing is open. */
  breaker: BreakerId | null;
  /**
   * What to put in `Retry-After`.
   *
   * A POLL INTERVAL, not a promise. Every window here is rolling, so the
   * moment a breaker closes depends on which rows age out and nobody can
   * compute it in advance — quoting the full window ("try in 24 hours") would
   * be pessimistic to the point of dishonesty for a spike that clears in ten
   * minutes. Null for the manual lock, which clears when a human says so.
   */
  retryAfterSeconds: number | null;
}

/**
 * How long to tell the caller to wait. A quarter of the breaker's window,
 * capped at an hour: long enough that a retry loop is not itself a load
 * problem, short enough to be worth obeying.
 */
export function retryAfterFor(windowHours: number): number {
  return Math.min(3600, Math.max(60, Math.round((windowHours * 3600) / 4)));
}

/**
 * May this action proceed?
 *
 * FAILS CLOSED, and this is the one place in the codebase where that is the
 * right direction — the exact opposite of `paywallEnabledFromValue`, which
 * fails to OFF and says so at length. The asymmetry there was: a blip that
 * answered "paywall on" walls innocent people, a blip that answered "off"
 * costs a few free turns. Here the asymmetry runs the other way. A blip that
 * refuses costs a few users a 503 and a retry; a blip that ALLOWS is the
 * attack window, during exactly the minutes an attack is most likely to be
 * causing the database trouble in the first place. And a Penny turn needs the
 * database anyway, so failing closed refuses a request that could not have
 * succeeded.
 *
 * Admin exemption is NOT here. It belongs at the call site, because the
 * accounting must happen either way and only the route knows who is asking.
 */
export function evaluateGate(
  gate: BreakerGate,
  facts: BreakerFacts,
  thresholds: readonly BreakerSpec[]
): GateVerdict {
  if (facts.factsUnavailable) {
    return { blocked: true, breaker: 'facts_unavailable', retryAfterSeconds: 60 };
  }
  for (const status of evaluateBreakers(facts, thresholds)) {
    if (status.gate !== gate) continue;
    if (status.level !== 'open') continue;
    return {
      blocked: true,
      breaker: status.id,
      retryAfterSeconds:
        status.id === 'manual_lock' ? null : retryAfterFor(status.windowHours),
    };
  }
  return { blocked: false, breaker: null, retryAfterSeconds: null };
}

/** The worst level across every breaker — what colour the admin banner is. */
export function worstLevel(statuses: readonly BreakerStatus[]): BreakerLevel {
  if (statuses.some((s) => s.level === 'open')) return 'open';
  if (statuses.some((s) => s.level === 'alert')) return 'alert';
  return 'ok';
}
