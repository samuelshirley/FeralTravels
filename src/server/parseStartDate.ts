import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { tryParseToISO } from '@/lib/dates';
import { DATE_PARSE_MODEL } from '@/lib/models';
import { logAnthropicUsageWithFallback } from '@/server/repos/usage';

/**
 * Trip start-date resolution.
 *
 * The onboarding `trip_date` step (and trip-date edits) must turn whatever the
 * user types into a machine date the DB can store as `start_date_parsed`. Most
 * input is handled instantly and for free by the deterministic parser in
 * `@/lib/dates` (`tryParseToISO`). Only when that returns null — genuinely
 * unusual phrasing the regex layer can't pin — do we pay for a small, strict
 * LLM call as a fallback. This keeps the common path fast/deterministic/testable
 * while still accepting the long tail ("the Friday after next", typos, etc.).
 *
 * IMPORTANT: this is the ONLY place an Anthropic call enters the onboarding date
 * flow. `@/lib/dates` stays pure and client-safe (it's imported by client
 * components for display) — never add an SDK import there.
 */

// Lazily constructed so merely importing this module never throws when no API
// key is set (e.g. in unit tests or a build pass). The SDK constructor throws
// on a missing key — defer it until we actually need the model.
let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Model ID lives in the central registry (@/lib/models) — hardcoded, no
// per-request fallback chain. If the API rejects it at runtime we catch, return
// null, and the caller re-asks; that's runtime error safety, not a model swap.
const DATE_MODEL = DATE_PARSE_MODEL;

// Hard ceiling on how long we'll wait for the fallback. Onboarding is
// interactive — better to re-ask than to hang.
const DATE_PARSE_TIMEOUT_MS = 6000;

// Forced tool call. Rather than hope the model emits clean JSON, we make it
// call this tool — the schema IS the contract, so the model can only hand back
// { date, exact } and never prose, markdown, or a hallucinated wrapper. We STILL
// validate the string server-side before it can touch the DB.
const DATE_TOOL: Anthropic.Tool = {
  name: 'record_parsed_date',
  description:
    'Record the trip start date as a strict ISO date plus whether the user named ' +
    'a specific day or only a vague timeframe.',
  input_schema: {
    type: 'object',
    required: ['date', 'exact'],
    properties: {
      date: {
        type: ['string', 'null'],
        description:
          'Exactly "YYYY-MM-DD" (zero-padded). If the user named a specific day, ' +
          'that day. If they named only a vague timeframe ("this summer", "early ' +
          'August", "next spring"), a sensible representative day WITHIN it (e.g. ' +
          '"this summer" → first day of summer, "early August" → Aug 1). null ONLY ' +
          'when the text gives no temporal signal at all ("no idea yet", garbage). ' +
          'No time, timezone, or extra text.',
      },
      exact: {
        type: 'boolean',
        description:
          'true ONLY if the user named a specific calendar day. false if you ' +
          'inferred the date from a vague timeframe, or there was none.',
      },
    },
  },
};

interface ResolveOpts {
  /** Injectable clock for tests + relative-date anchoring. */
  now?: Date;
  /** For usage accounting; logging is skipped when absent. */
  userId?: string;
  tripId?: string;
}

/**
 * Validate that a model-returned string is a real ISO "YYYY-MM-DD" within a
 * sane window. Pure — exported for unit testing. Rejects malformed strings,
 * impossible days (Feb 30), and years outside [lastYear, 2100] so a hallucinated
 * or past date can't slip through as a trip start.
 */
export function validateISODateString(
  raw: unknown,
  now: Date = new Date(),
): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = +m[1];
  const month = +m[2];
  const day = +m[3];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null; // e.g. 2026-02-30
  }
  // Trip starts are today-or-future; allow a 1-year grace for clock skew /
  // edits to slightly-past trips, but reject anything wildly off.
  if (year < now.getFullYear() - 1 || year > 2100) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function todayISOFrom(now: Date): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** Result of an LLM date parse. `exact` is false when the date was inferred
 * from a vague timeframe (or there's no date at all). */
export interface LLMDateResult {
  iso: string | null;
  exact: boolean;
}

/**
 * LLM fallback: ask a small model to turn free text into a strict ISO date.
 * Returns { iso, exact }: a representative day within any timeframe the user
 * named (exact=false), or { iso: null } when there's no temporal signal / API
 * error / timeout / no key. Never throws.
 */
export async function parseDateWithLLM(
  text: string,
  opts: ResolveOpts = {},
): Promise<LLMDateResult> {
  const anthropic = getClient();
  if (!anthropic) return { iso: null, exact: false };
  const trimmed = text.trim();
  if (!trimmed) return { iso: null, exact: false };

  const now = opts.now ?? new Date();
  const todayStr = todayISOFrom(now);
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });

  const system =
    `You extract the trip START date from the user's text and record it via the ` +
    `record_parsed_date tool. Call that tool exactly once; output nothing else.\n` +
    `Today is ${todayStr} (${weekday}). A trip start date is always today or in the future:\n` +
    `- Resolve a date with no year, or a relative phrase ("next Friday", "in two weeks", "tomorrow"), to the next upcoming occurrence from today. Set exact=true.\n` +
    `- Interpret numeric dates DAY-FIRST (e.g. "27-6-26" = 27 June 2026, "3/6/26" = 3 June 2026) unless the text is clearly US month-first. Set exact=true.\n` +
    `- If the user names only a VAGUE timeframe ("this summer", "early August", "next spring"), pick a sensible representative day WITHIN it (first day of that season/month) and set exact=false. Do not go back and forth — just pick.\n` +
    `- Only when there is NO temporal signal at all ("no idea yet", garbage) set date=null, exact=false.\n` +
    `- date MUST be exactly "YYYY-MM-DD" (zero-padded), a real calendar day, no time or timezone.`;

  let resp: Anthropic.Message;
  try {
    resp = await anthropic.messages.create(
      {
        model: DATE_MODEL,
        max_tokens: 128,
        temperature: 0,
        system,
        tools: [DATE_TOOL],
        tool_choice: { type: 'tool', name: DATE_TOOL.name },
        messages: [{ role: 'user', content: trimmed.slice(0, 200) }],
      },
      { timeout: DATE_PARSE_TIMEOUT_MS },
    );
  } catch (err) {
    console.warn(
      `[parseStartDate] LLM fallback failed (model=${DATE_MODEL}): ${
        (err as Error)?.message ?? err
      }`,
    );
    return { iso: null, exact: false };
  }

  // Best-effort usage accounting — never let it block or throw.
  if (opts.userId) {
    void logAnthropicUsageWithFallback({
      userId: opts.userId,
      tripId: opts.tripId ?? null,
      model: DATE_MODEL,
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: resp.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: resp.usage?.cache_read_input_tokens ?? 0,
      success: true,
    }).catch(() => {});
  }

  // tool_choice forces exactly this tool, so the answer is in its input — no
  // prose to scrape. Validate the string before trusting it (the schema can't
  // enforce a real calendar day; validateISODateString does).
  const toolUse = resp.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === 'tool_use' && b.name === DATE_TOOL.name,
  );
  if (!toolUse) return { iso: null, exact: false };
  const input = (toolUse.input ?? {}) as { date?: unknown; exact?: unknown };
  const iso = validateISODateString(input.date, now);
  return { iso, exact: iso != null && input.exact === true };
}

/**
 * A resolved trip start date.
 * - `iso` is null ONLY when the text gives no temporal signal at all ("no idea
 *   yet"). The caller MUST handle that (ask once, then fall back) — never
 *   persist null; trip dates are a hard non-null invariant.
 * - `assumed` is true when WE inferred the date from a vague timeframe
 *   ("this summer") rather than the user naming a specific day.
 */
export interface ResolvedStartDate {
  iso: string | null;
  assumed: boolean;
}

/**
 * Resolve a user's free-text trip start date. Deterministic parse first (fast,
 * free, exact); then the LLM, which pins a specific day OR picks a representative
 * day within a vague timeframe (assumed). Returns iso=null only when there's no
 * temporal signal at all — the onboarding form turns that into one clarifying
 * question and, failing that, a "start today" fallback. We deliberately do NOT
 * default to a date here so the form can decide the UX.
 */
export async function resolveStartDate(
  text: string,
  opts: ResolveOpts = {},
): Promise<ResolvedStartDate> {
  const now = opts.now ?? new Date();
  const deterministic = tryParseToISO(text, now);
  if (deterministic) return { iso: deterministic, assumed: false };
  const llm = await parseDateWithLLM(text, { ...opts, now });
  if (llm.iso) return { iso: llm.iso, assumed: !llm.exact };
  return { iso: null, assumed: false };
}
