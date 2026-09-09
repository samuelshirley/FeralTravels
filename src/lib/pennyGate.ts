/**
 * The message gate — the last line before Penny, and the only place in the
 * lockdown work that consults a model.
 *
 * Every message that gets this far has already passed the global circuit
 * breakers, the per-IP limits and the per-account caps. Those bound the damage;
 * this one decides whether a particular message is worth spending $0.085 on at
 * all, and it does so for $0 in the common case.
 *
 * ── Three tiers ──
 *
 *  T1 — this trip. Route, days, stops, fuel, the vehicle, dates, places on the
 *       way, the driver's own situation ("we stopped early", "150 km in the
 *       tank", "anything with a cheeseburger between Marfa and Big Bend").
 *       Goes to Penny, exactly as today.
 *  T2 — adjacent. About the trip, but not something Penny can act on: weather,
 *       opening hours, visas, road conditions. Gets one honest line and no
 *       model call. Not a strike — this is a real driver asking a real
 *       question.
 *  T3 — junk. Code, gibberish, prompt-injection shapes, nothing to do with any
 *       trip. Refused, +1 strike, no model call.
 *
 * ── Three deciders, in order, and the first two are free ──
 *
 *  1. Deterministic ALLOW. The message names something in THIS trip, or uses
 *     the vocabulary every driver uses. Most real messages end here.
 *  2. Deterministic DENY. Shapes no driver ever types.
 *  3. The classifier. One forced-tool Haiku call for the remainder, biased to
 *     allow.
 *
 * ── What this deliberately is NOT ──
 *
 * A keyword state machine for the whole problem. That was raised and argued
 * down, and the argument is worth keeping: language does not enumerate, so a
 * keyword list fails toward blocking real drivers — and it fails open against
 * the attacker anyway, who reads it and includes the word "trip". So the
 * deterministic layers are held to what NO driver would ever type and what
 * EVERY driver types, and the ambiguous middle goes to a model that costs half
 * a hundredth of a cent.
 *
 * Pure and shared to mobile: the app renders the T2 and T3 lines, so the copy
 * has to have one definition.
 */

export type MessageTier = 'T1' | 'T2' | 'T3';

/** Which layer decided. Recorded per message, so the mix is measurable. */
export type GateDecider = 'allow_rule' | 'deny_rule' | 'classifier' | 'error';

export interface GateDecision {
  tier: MessageTier;
  by: GateDecider;
  /** Short, for the log and the admin panel. Never shown to the driver. */
  reason: string;
}

/**
 * Hard cap on one chat message. The composer has no client-side limit
 * (deliberate — pasting an itinerary in should work), so this is the server
 * side of it. 4,000 characters is ~1,000 tokens: room for "plan a 14-day trip
 * from X to Y hitting A, B and C" and a paragraph of elaboration. Longer is
 * somebody pasting junk to burn tokens.
 */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * The T2 line. ONE string, rendered verbatim by both clients.
 *
 * It says what Penny cannot do and then offers the thing she can, because the
 * driver asking about the weather is not making a mistake — they are asking
 * the only assistant they have. A flat "I can't help with that" would be true
 * and useless.
 */
export const T2_MESSAGE =
  "I can't check that, but I can plan around it — tell me what you'd change.";

/**
 * The T3 line. States the boundary, once, without a lecture and without
 * inviting a negotiation about it.
 */
export const T3_MESSAGE = "I only work on your trip — routes, days, stops and fuel.";

/**
 * The vocabulary every driver uses and almost nobody else does in this app.
 *
 * Word-bounded and case-insensitive. Kept SHORT on purpose: every addition
 * widens the free pass, and the classifier behind it is already biased to
 * allow, so a word that only sometimes means a trip belongs there rather than
 * here.
 */
export const TRIP_VOCABULARY =
  /\b(fuel|petrol|diesel|gas station|km|kms|miles?|mi|day \d+|stop|stops|route|drive|driving|drove|leg|legs|tank|range|camp|campsite|park|road|itinerary|trip|refuel|overnight|detour)\b/i;

/**
 * Shapes no driver types into a trip planner.
 *
 * Every one of these is a thing that is either code or an attempt to talk to
 * the model rather than to Penny. They are matched BEFORE the allow rules
 * because "SELECT * FROM trips" contains the word "trips".
 */
const DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /```/, reason: 'code fence' },
  { re: /\bfunction\s*\w*\s*\(/, reason: 'function definition' },
  { re: /^\s*import\s+[\w{*]/m, reason: 'import statement' },
  { re: /\bSELECT\b[\s\S]*\bFROM\b/i, reason: 'sql' },
  { re: /<script\b/i, reason: 'script tag' },
  { re: /\b(ignore|disregard|forget)\b[\s\S]{0,40}\b(previous|prior|above|earlier|all)\b[\s\S]{0,40}\b(instruction|prompt|rule|direction)/i, reason: 'prompt injection' },
  { re: /\byou are now\b|\bact as\b[\s\S]{0,30}\b(assistant|ai|model|dan)\b/i, reason: 'role reassignment' },
  { re: /\b(system prompt|your instructions|reveal your)\b/i, reason: 'prompt extraction' },
];

/** A word made only of consonants and punctuation is not a sentence. */
function hasNoVowels(text: string): boolean {
  return !/[aeiouyАаЕеИиОоУуЭэЮюЯяÀ-ɏͰ-῿぀-ヿ一-鿿]/i.test(text);
}

export interface GateInput {
  message: string;
  /**
   * Names from THIS trip — leg titles, place names, stop names, the vehicle's
   * name. Lowercased by the caller or not; matching is case-insensitive.
   */
  tripNames: readonly string[];
  /** The account's last few messages, to catch an exact repeat. */
  recentMessages: readonly string[];
}

/**
 * The free deciders. Returns null when neither fires and the classifier is
 * needed — which is the only path that costs anything.
 */
export function decideDeterministically(input: GateInput): GateDecision | null {
  const raw = input.message ?? '';
  const text = raw.trim();

  if (text.length === 0) {
    return { tier: 'T3', by: 'deny_rule', reason: 'empty' };
  }
  if (raw.length > MAX_MESSAGE_CHARS) {
    return { tier: 'T3', by: 'deny_rule', reason: 'over length' };
  }
  for (const { re, reason } of DENY_PATTERNS) {
    if (re.test(text)) return { tier: 'T3', by: 'deny_rule', reason };
  }
  if (text.length > 12 && hasNoVowels(text)) {
    return { tier: 'T3', by: 'deny_rule', reason: 'no vowels' };
  }
  /*
   * An exact repeat of something the account just sent. A driver who resends
   * the same sentence is almost always retrying a message that failed, so this
   * is deliberately EXACT (after trimming and case-folding) rather than fuzzy —
   * "same again please" is a real message and must not match.
   */
  const folded = text.toLowerCase();
  if (input.recentMessages.some((m) => m.trim().toLowerCase() === folded)) {
    return { tier: 'T3', by: 'deny_rule', reason: 'exact repeat' };
  }

  // ── Allow ──
  for (const name of input.tripNames) {
    const trimmed = name?.trim();
    // Two characters would match half the alphabet inside longer words.
    if (!trimmed || trimmed.length < 3) continue;
    if (folded.includes(trimmed.toLowerCase())) {
      return { tier: 'T1', by: 'allow_rule', reason: `names "${trimmed}"` };
    }
  }
  if (TRIP_VOCABULARY.test(text)) {
    return { tier: 'T1', by: 'allow_rule', reason: 'trip vocabulary' };
  }

  return null;
}

/** The line a client renders for a gated tier. Null for T1 — Penny answers. */
export function gateMessageFor(tier: MessageTier): string | null {
  if (tier === 'T2') return T2_MESSAGE;
  if (tier === 'T3') return T3_MESSAGE;
  return null;
}
