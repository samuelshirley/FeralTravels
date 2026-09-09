import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { chatHistory, legs, stops, trips, vehicles } from '@/server/db/schema';
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
import { classifyMessage } from './pennyClassifier';

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
}): Promise<GateOutcome> {
  const now = input.now ?? new Date();

  if (input.isAdmin) {
    return { tier: 'T1', by: 'allow_rule', reason: 'admin', blocked: false, message: null, lockedUntil: null };
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
    };
  }

  const [vocab, recent] = await Promise.all([
    tripVocabulary(input.tripId),
    recentUserMessages(input.tripId),
  ]);

  let decision = decideDeterministically({
    message: input.message,
    tripNames: vocab.names,
    recentMessages: recent,
  });

  if (!decision) {
    const classified = await classifyMessage(
      input.message,
      { tripName: vocab.tripName, places: vocab.names },
      input.userId,
      input.tripId
    );
    decision = { tier: classified.tier, by: classified.by, reason: classified.reason };
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
    };
  }

  return {
    tier: decision.tier,
    by: decision.by,
    reason: decision.reason,
    blocked: decision.tier !== 'T1',
    message: gateMessageFor(decision.tier),
    lockedUntil: null,
  };
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
