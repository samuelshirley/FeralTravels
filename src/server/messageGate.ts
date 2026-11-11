import 'server-only';
import {
  typeSafeConsentFrom,
  type AiConsentProof,
  type TypeSafeConsentProof,
} from '@/server/aiConsent';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { chatHistory, legs, stops, trips, vehicles } from '@/server/db/schema';
import { previousAssistantRow } from '@/server/repos/chat';
import { logUsageEvent } from '@/server/repos/usage';
import { getStrikeState, setStrikeState } from '@/server/repos/users';
import { GATE_PROVIDER } from '@/server/payments';
import {
  decideDeterministically,
  gateMessageFor,
  type GateDecision,
  type MessageTier,
} from '@/lib/pennyGate';
import {
  isAccountPennyLocked,
  nextStrikeState,
  strikeLockMinutesRemaining,
  STRIKE_LOCK_MESSAGE,
} from '@/lib/strikes';
import { classifyMessage, type ClassifyContext } from './pennyClassifier';
import { jevClassifyTier, startJevCompare } from '@/server/jev';
import {
  effectiveJevMode,
  logJevCompare,
  logJevUsage,
  type JevModeSource,
} from '@/server/repos/jev';

/**
 * The message gate, assembled: is Penny paused for this account, what tier is
 * this message, and what does that cost the account.
 *
 * The DECISIONS are pure and live elsewhere — `lib/pennyGate.ts` sorts the
 * message, `lib/strikes.ts` decides what a junk one costs. This file supplies
 * the facts they need and writes down what happened.
 */

export interface GateOutcome {
  tier: MessageTier;
  by: GateDecision['by'];
  reason: string;
  /** True when Penny must NOT be called. */
  blocked: boolean;
  /** The line to put in the transcript instead of Penny's reply. */
  message: string | null;
  /** Set when this message tripped the third strike. */
  lockedUntil: Date | null;
  /**
   * The `usage_events` id of this message's Jev compare row, when compare
   * mode asked Jev about it; null otherwise. The replan route links it to the
   * Penny turn the message starts (`linkJevCompareToTurn`), so what Penny then
   * did is recorded beside what Jev said. Measurement only.
   */
  jevCompareEventId: number | null;
}

/** How many of the account's recent messages count as "an exact repeat of". */
const RECENT_MESSAGE_WINDOW = 5;

/**
 * Names from this trip, so "Marfa" or "the Hilux" is recognised for free.
 *
 * Deliberately only NAMES — no dates, no distances, no coordinates. This list
 * is handed to a model in the classifier path, and the less of a driver's
 * itinerary that travels the better. Bounded, because a 40-leg trip would
 * otherwise put a paragraph in front of every classify call.
 */
export async function tripVocabulary(tripId: string): Promise<{
  tripName: string | null;
  names: string[];
}> {
  const [trip] = await db
    .select({ name: trips.name, vehicleId: trips.vehicleId })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);

  const legRows = await db
    .select({ title: legs.title, start: legs.startName, end: legs.endName })
    .from(legs)
    .where(eq(legs.tripId, tripId))
    .limit(60);

  const stopRows = await db
    .select({ name: stops.name })
    .from(stops)
    .innerJoin(legs, eq(stops.legId, legs.id))
    .where(eq(legs.tripId, tripId))
    .limit(60);

  let vehicleName: string | null = null;
  if (trip?.vehicleId) {
    const [v] = await db
      .select({ name: vehicles.name })
      .from(vehicles)
      .where(eq(vehicles.id, trip.vehicleId))
      .limit(1);
    vehicleName = v?.name ?? null;
  }

  const names = [
    ...legRows.flatMap((l) => [l.title, l.start, l.end]),
    ...stopRows.map((s) => s.name),
    vehicleName,
    trip?.name ?? null,
  ].filter((n): n is string => typeof n === 'string' && n.trim().length >= 3);

  return { tripName: trip?.name ?? null, names: Array.from(new Set(names)).slice(0, 80) };
}

async function recentUserMessages(tripId: string): Promise<string[]> {
  const rows = await db
    .select({ content: chatHistory.content })
    .from(chatHistory)
    .where(eq(chatHistory.tripId, tripId))
    .orderBy(desc(chatHistory.seq))
    .limit(RECENT_MESSAGE_WINDOW * 3);
  return rows.map((r) => r.content).slice(0, RECENT_MESSAGE_WINDOW);
}

/**
 * Run the gate. Returns what to do; writes the strike state and the usage row.
 *
 * ── The lock is checked FIRST, before anything is classified ──
 *
 * An account inside its hour gets the lock line and nothing else runs — no
 * deterministic pass, no classifier, no cost. Which also means a locked account
 * cannot accumulate further strikes, so the hour is the whole consequence.
 */
export async function gateMessage(input: {
  userId: string;
  tripId: string;
  message: string;
  /** Admins are never gated. They are the ones debugging it. */
  isAdmin?: boolean;
  now?: Date;
  /**
   * The user's agreement to send their message to Anthropic (the Haiku
   * classifier) — `src/server/aiConsent.ts`.
   */
  consent: AiConsentProof;
}): Promise<GateOutcome> {
  const now = input.now ?? new Date();

  if (input.isAdmin) {
    return {
      tier: 'T1',
      by: 'allow_rule',
      reason: 'admin',
      blocked: false,
      message: null,
      lockedUntil: null,
      jevCompareEventId: null,
    };
  }

  const strike = await getStrikeState(input.userId);
  if (isAccountPennyLocked(strike.lockedUntil, now)) {
    const mins = strikeLockMinutesRemaining(strike.lockedUntil!, now);
    await record(input, { tier: 'T3', by: 'deny_rule', reason: `locked, ${mins}m left` });
    return {
      tier: 'T3',
      by: 'deny_rule',
      reason: `locked, ${mins}m left`,
      blocked: true,
      message: STRIKE_LOCK_MESSAGE,
      lockedUntil: strike.lockedUntil,
      jevCompareEventId: null,
    };
  }

  const [vocab, recent, previousRow] = await Promise.all([
    tripVocabulary(input.tripId),
    recentUserMessages(input.tripId),
    previousAssistantRow(input.tripId),
  ]);
  const previousAssistant = previousRow?.content ?? null;

  let decision = decideDeterministically({
    message: input.message,
    tripNames: vocab.names,
    recentMessages: recent,
    previousAssistant,
    previousAssistantFellBack: previousRow?.fellBack ?? false,
  });

  // Penny's previous message travels to BOTH classifiers (Jev's question is
  // built by the same `buildClassifyContent`): a reply cannot be judged
  // without what it replies to.
  const ctx: ClassifyContext = { tripName: vocab.tripName, places: vocab.names, previousAssistant };

  /*
   * TypeSafe sees nothing for an account that has not agreed to the consent
   * sheet naming it (version ≥ 2): no proof, no Jev — compare and Jev-first
   * both become Haiku only, exactly as with the switch off.
   */
  const typeSafe = typeSafeConsentFrom(input.consent);
  let jevCompareEventId: number | null = null;

  if (!decision) {
    let haikuMicrocents: number | null = null;
    const haiku = async (): Promise<GateDecision> => {
      const classified = await classifyMessage(input.message, ctx, input.userId, input.tripId, input.consent);
      haikuMicrocents = classified.microcents;
      return { tier: classified.tier, by: classified.by, reason: classified.reason };
    };
    const { mode, source } = typeSafe ? await effectiveJevMode(input.userId) : OFF;
    if (mode === 'compare' && typeSafe) {
      // Haiku decides, exactly as with the switch off; Jev is only logged.
      const compared = await haikuComparedWithJev(input, ctx, source, haiku, () => haikuMicrocents, typeSafe);
      decision = compared.decision;
      jevCompareEventId = compared.eventId;
    } else {
      // Jev may settle a confident T1 and nothing else; every other outcome,
      // and the switch being off, is Haiku exactly as before.
      decision = mode === 'on' && typeSafe ? await jevSettles(input, ctx, source, typeSafe) : null;
      if (!decision) decision = await haiku();
    }
  } else if (decision.tier === 'T1' && typeSafe) {
    /*
     * The free rules let it through, so no classifier runs and nothing is
     * there to compare the tier with — but the ROUTE question is exactly
     * about these messages (a Maps link, "a different gas station"). In
     * compare mode Jev is asked that question alone, and the answer is only
     * logged. The decision above stands untouched.
     */
    const { mode, source } = await effectiveJevMode(input.userId);
    if (mode === 'compare') {
      jevCompareEventId = await routeOnlyCompare(input, ctx, source, typeSafe);
    }
  }

  await record(input, decision);

  const next = nextStrikeState({ tier: decision.tier, strikes: strike.strikes, now });
  if (next.strikes !== strike.strikes || next.lockedUntil) {
    await setStrikeState(input.userId, next).catch((err) =>
      console.error('[messageGate] could not write the strike state', err)
    );
  }

  if (next.lockedUntil) {
    // The message that tripped the lock is refused with the LOCK line rather
    // than the junk line: "Penny is paused for an hour" is the fact that
    // changed, and hearing the same refusal three times and then silence is
    // how a lock reads as the app breaking.
    return {
      tier: decision.tier,
      by: decision.by,
      reason: decision.reason,
      blocked: true,
      message: STRIKE_LOCK_MESSAGE,
      lockedUntil: next.lockedUntil,
      jevCompareEventId,
    };
  }

  return {
    tier: decision.tier,
    by: decision.by,
    reason: decision.reason,
    blocked: decision.tier !== 'T1',
    message: gateMessageFor(decision.tier),
    lockedUntil: null,
    jevCompareEventId,
  };
}

/** No TypeSafe consent: the switch is not even read, and the mode is off. */
const OFF = { mode: 'off', source: 'global' } as const satisfies { mode: string; source: JevModeSource };

/**
 * Compare mode: Haiku decides, and Jev is asked the same tier question — plus
 * the route question, in the same request — at the same moment, so its
 * answers can be logged beside Haiku's.
 *
 * The returned decision is HAIKU'S, always — the same tier, reason and strike
 * as mode off. Jev's outcome is read only to be written down, and it is read
 * with a deadline: Jev's own timeout, counted from when Jev was started, so
 * the most compare mode adds to a message is whatever of `JEV_TIMEOUT_MS` is
 * left once Haiku has answered. A Jev error or timeout is one row with
 * `success: false` and changes nothing else.
 */
async function haikuComparedWithJev(
  input: { userId: string; tripId: string; message: string },
  ctx: ClassifyContext,
  source: JevModeSource,
  haiku: () => Promise<GateDecision>,
  haikuMicrocents: () => number | null,
  typeSafe: TypeSafeConsentProof
): Promise<{ decision: GateDecision; eventId: number | null }> {
  const readJev = startJevCompare(input.message, ctx, typeSafe, input.userId, { askTier: true });
  const decision = await haiku();
  const outcome = await readJev();
  const eventId = await logJevCompare({
    userId: input.userId,
    tripId: input.tripId,
    source,
    outcome,
    gate: { by: 'classifier', haikuTier: decision.tier, haikuMicrocents: haikuMicrocents() },
  });
  return { decision, eventId };
}

/**
 * Compare mode, for a message the free rules already let through: Jev is
 * asked the ROUTE question only, and the answer is logged. Bounded by Jev's
 * own timeout (the reader's deadline), and it never changes the decision —
 * there is nothing here it could change.
 */
async function routeOnlyCompare(
  input: { userId: string; tripId: string; message: string },
  ctx: ClassifyContext,
  source: JevModeSource,
  typeSafe: TypeSafeConsentProof
): Promise<number | null> {
  const outcome = await startJevCompare(input.message, ctx, typeSafe, input.userId, { askTier: false })();
  return logJevCompare({
    userId: input.userId,
    tripId: input.tripId,
    source,
    outcome,
    gate: { by: 'allow_rule', haikuTier: null, haikuMicrocents: null },
  });
}

/**
 * Jev's turn, when the admin switch puts this account on Jev-first.
 *
 * Returns a decision ONLY for a confident T1 (`src/server/jev/decide.ts`), and
 * null for everything else — a T2, a T3, an unsure T1, an error, a timeout, no
 * config, the switch off — so the caller asks Haiku exactly as it always has
 * and Haiku's answer is final. Jev can therefore let a message through; it can
 * never refuse one, and it can never put a strike on anybody.
 *
 * Only called with the mode on; with it off the gate makes no network call.
 * Every Jev call writes its own `provider: 'jev'` row; the gate's own
 * `penny:gate` row still records the final decision, with `by: 'classifier'`
 * and a reason naming Jev when Jev decided.
 */
async function jevSettles(
  input: { userId: string; tripId: string; message: string },
  ctx: ClassifyContext,
  source: JevModeSource,
  typeSafe: TypeSafeConsentProof
): Promise<GateDecision | null> {
  const outcome = await jevClassifyTier(input.message, ctx, typeSafe, input.userId);
  await logJevUsage({
    userId: input.userId,
    tripId: input.tripId,
    source,
    outcome,
    model: outcome.echoedModel,
  });
  if (!outcome.settled || outcome.top === null) return null;
  return { tier: 'T1', by: 'classifier', reason: `jev T1 p=${outcome.top.toFixed(2)}` };
}

/**
 * One `usage_events` row per gate decision.
 *
 * `provider: 'penny:gate'`, `model` = the tier — which is exactly what the
 * `gated_messages_1h` breaker counts, so the smoke detector and the record are
 * the same rows rather than two things that can disagree. `requests: 1` even at
 * zero cost, because the interesting number is HOW MANY, and a deterministic
 * decision costing nothing is the outcome worth counting most.
 *
 * Never throws: a bookkeeping failure must not refuse a message.
 */
async function record(
  input: { userId: string; tripId: string },
  decision: GateDecision
): Promise<void> {
  await logUsageEvent({
    userId: input.userId,
    tripId: input.tripId,
    provider: GATE_PROVIDER,
    model: decision.tier,
    requests: 1,
    /*
     * TRUE, always. `/admin/errors` reads `usage_events WHERE success = false`,
     * and a refused junk message is not an error — filing every T3 there would
     * bury the real failures under exactly the traffic this feature exists to
     * make boring. Same reasoning as the paywall-switch row: it is in the
     * ledger to be findable, not to be alarming.
     */
    success: true,
    errorMessage: `${decision.tier} by ${decision.by}: ${decision.reason}`.slice(0, 200),
  }).catch((err) => console.error('[messageGate] could not record the decision', err));
}
