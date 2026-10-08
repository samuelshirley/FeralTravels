import { T2_MESSAGE, T3_MESSAGE } from '@/lib/pennyGate';

/**
 * A bare "yes" is not something to interpret. It means: do what you just
 * proposed.
 *
 * THE INCIDENT (trip 9a3df982, 2026-10-08). Penny ended a message with "Both
 * good?" about two place choices. The driver answered "yup". Penny made one
 * model call, no tool calls, and asked ANOTHER confirmation question. Later,
 * "whatever you choose" did work, but only on the turn after. Nothing was
 * wrong with the model's reading of the word — it was handed the word "yup"
 * and a 13k-token prompt that tells it, in several places, to confirm before
 * editing, and it confirmed.
 *
 * So the reading is taken away from it. This module decides, in code and
 * without a model call, that a message is nothing but an acceptance.
 *
 *  - When Penny STAGED her answer to the question (`hold_for_confirmation`,
 *    lib/penny/stagedPlan.ts), `classifyReply` is all the route needs: a yes
 *    applies the held writes and Penny is never called.
 *  - When she asked without staging, `detectAcceptance` decides the reply
 *    accepts what she proposed, and the replan loop hands her an explicit
 *    instruction (her own message, quoted, and "carry it out now") beside the
 *    bare word. The transcript keeps the driver's actual word — this only
 *    changes what Penny is told.
 *
 * Narrower than the gate's `isBareReply` on purpose: that one also lets a
 * DECLINE, an UNDO and a PICK through for free, and none of those mean "do
 * what you proposed".
 */

export type AcceptanceKind =
  /** "yes", "sounds good", "both good", "do it" — do exactly what you proposed. */
  | 'accept'
  /** "whatever you choose", "you pick" — the choice is yours; take your recommendation. */
  | 'delegate';

export interface Acceptance {
  kind: AcceptanceKind;
  /** What the driver actually typed. */
  reply: string;
  /** Penny's message they were answering, verbatim. */
  proposal: string;
}

/** Phrases that accept a proposal as written. Written without apostrophes — see `normaliseReply`. */
const ACCEPT_PHRASES = [
  'yes', 'yeah', 'yea', 'yep', 'yup', 'ya', 'yes please', 'ok', 'okay', 'k', 'sure', 'alright',
  'all right', 'right', 'correct', 'perfect', 'great', 'good', 'fine', 'cool', 'deal', 'agreed',
  'absolutely', 'definitely', 'of course', 'confirmed', 'confirm', 'proceed',
  'sounds good', 'sounds great', 'sounds perfect', 'sounds fine', 'looks good', 'looks great',
  'both good', 'both great', 'both fine', 'both work', 'both are good', 'all good', 'all fine',
  'do it', 'do that', 'do this', 'do both', 'do them all', 'do all of them', 'do all',
  'lets do it', 'lets do that', 'lets do them all', 'lets do both', 'lets go',
  'go ahead', 'go for it', 'please do', 'that works', 'works for me', 'thats fine',
  'thats right', 'thats good', 'thats perfect', 'yes do it', 'make it so',
];

/** Phrases that hand the choice to Penny. */
const DELEGATE_PHRASES = [
  'whatever', 'whatever you choose', 'whatever you pick', 'whatever you decide',
  'whatever you think', 'whatever you think is best', 'whatever you want', 'whatever you like',
  'whatever is best', 'whatever works', 'whatever works best',
  'whatevers best', 'up to you', 'its up to you', 'you choose', 'you pick', 'you decide',
  'your call', 'your choice', 'surprise me', 'either', 'either one', 'either is fine',
  'either works', 'i dont mind', 'dont mind', 'dealers choice', 'you know best',
  'your pick', 'pick for me', 'choose for me', 'you tell me',
];

/** May pad a reply; never makes one on its own. */
const FILLER = [
  'please', 'thanks', 'thank you', 'thx', 'ty', 'then', 'just', 'and', 'a', 'the', 'that',
  'it', 'this', 'oh', 'so', 'well', 'mate', 'man', 'haha', 'lol', 'all', 'them', 'is', 'fine',
  'really', 'totally', 'sounds',
];

/** "About eight words": a reply, not a sentence with content of its own. */
export const MAX_ACCEPTANCE_WORDS = 8;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (phrases: string[]) =>
  `(?:${[...phrases].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})`;

const ANY_RE = alternation([...ACCEPT_PHRASES, ...DELEGATE_PHRASES, ...FILLER]);
const SHAPE_RE = new RegExp(`^${ANY_RE}(?: ${ANY_RE})*$`);
const ACCEPT_CORE_RE = new RegExp(`(?:^| )${alternation(ACCEPT_PHRASES)}(?: |$)`);
const DELEGATE_CORE_RE = new RegExp(`(?:^| )${alternation(DELEGATE_PHRASES)}(?: |$)`);

/**
 * Lowercase, apostrophes REMOVED ("let's" → "lets", "don't" → "dont"), every
 * other non-alphanumeric character — punctuation, emoji — to a space.
 */
export function normaliseReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether `text` is NOTHING BUT an acceptance (or a hand-off of the choice).
 * Null for anything else — including "yes but skip Tabernas", which carries
 * an instruction of its own and must be read as one.
 */
export function classifyReply(text: string): AcceptanceKind | null {
  const n = normaliseReply(text);
  if (!n || n.split(' ').length > MAX_ACCEPTANCE_WORDS) return null;
  if (!SHAPE_RE.test(n)) return null;
  if (DELEGATE_CORE_RE.test(n)) return 'delegate';
  if (ACCEPT_CORE_RE.test(n)) return 'accept';
  return null;
}

/**
 * A closing question that invites a NEW request rather than proposing
 * something. "Yes" to "Want to adjust anything?" means "I have a change", not
 * "do it" — there is nothing to do, and forcing a tool call there would make
 * her invent an edit.
 */
const OPEN_INVITATION_RE =
  /\b(adjust|change|tweak|modify|edit|add) anything\b|\banything else\b|\bwhat (else )?(would|do|did) you (like|want|have in mind)\b|\bwhere (are we|do you want to|would you like to) (go|going|start)\b|\bwhat('s| is) next\b/i;

/** The last sentence of `text` that ends in a question mark, or null. */
export function lastQuestion(text: string): string | null {
  const end = text.lastIndexOf('?');
  if (end < 0) return null;
  const before = text.slice(0, end);
  const start = Math.max(
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('?'),
    before.lastIndexOf('\n'),
  );
  return text.slice(start + 1, end + 1).trim();
}

/**
 * The message Penny sent immediately before the driver's `userMessage`, taken
 * from the transcript tail Penny is already given. Null when the row before
 * the driver's message is not hers (the driver sent two in a row), or when it
 * is one of the gate's own canned lines, which propose nothing.
 */
export function previousAssistantMessage(
  recentChat: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string,
): string | null {
  const want = userMessage.trim();
  let i = -1;
  for (let k = recentChat.length - 1; k >= 0; k--) {
    if (recentChat[k].role === 'user' && recentChat[k].content.trim() === want) {
      i = k;
      break;
    }
  }
  if (i <= 0) return null;
  const prev = recentChat[i - 1];
  if (prev.role !== 'assistant') return null;
  const content = prev.content.trim();
  if (!content || content === T2_MESSAGE || content === T3_MESSAGE) return null;
  return content;
}

/**
 * The whole decision. An acceptance only when (1) the driver's message is
 * nothing but an acceptance or a hand-off, (2) Penny's message right before it
 * asked something, (3) that question proposed something rather than inviting
 * a new request, and (4) for a plain "yes", the question was not an either/or
 * — "yes" to "A, or B?" says nothing about which. ("You pick" to an either/or
 * is fine: that is exactly what it answers.)
 */
export function detectAcceptance(
  userMessage: string,
  previousAssistant: string | null,
): Acceptance | null {
  if (!previousAssistant) return null;
  const kind = classifyReply(userMessage);
  if (!kind) return null;
  const question = lastQuestion(previousAssistant);
  if (!question) return null;
  if (OPEN_INVITATION_RE.test(question)) return null;
  if (kind === 'accept' && /\bor\b/i.test(question)) return null;
  return { kind, reply: userMessage.trim(), proposal: previousAssistant };
}

/** Penny's message is quoted to her whole, up to this many characters. */
const MAX_QUOTED_PROPOSAL_CHARS = 2_000;

/**
 * What Penny is told instead of the bare word. Appended to the turn's user
 * message, after the driver's own words, so her context still shows exactly
 * what they typed.
 */
export function acceptanceInstruction(a: Acceptance): string {
  const quoted =
    a.proposal.length > MAX_QUOTED_PROPOSAL_CHARS
      ? `${a.proposal.slice(0, MAX_QUOTED_PROPOSAL_CHARS)}…`
      : a.proposal;
  const lines = [
    '<accepted_proposal>',
    `The user's whole reply was "${a.reply}". That is an ACCEPTANCE of your previous message, quoted here:`,
    '"""',
    quoted,
    '"""',
    'Carry it out NOW with tools, as you proposed it. If you offered choices, take the one you recommended (if you recommended none, take the first). Do NOT ask the user to confirm again, and do NOT ask a new question about the same thing — they already answered it. If a tool rejects part of it, do the rest and say plainly what could not be done and why.',
  ];
  if (a.kind === 'delegate') {
    lines.push(
      'The user left the choice to YOU. Any place you choose this turn is your pick, not theirs: save it with source="penny", never source="user".',
    );
  }
  lines.push('</accepted_proposal>');
  return lines.join('\n');
}
