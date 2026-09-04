import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { ONBOARDING_SCAN_MODEL } from '@/lib/models';
import { validateRangeKm } from '@/lib/vehicleProfile';
import { parseDailyDriveHours } from '@/lib/onboardingForm';
import { resolveStartDate, type ResolvedStartDate } from '@/server/parseStartDate';
import { logAnthropicUsageWithFallback } from '@/server/repos/usage';

/**
 * First-message intent scan.
 *
 * Onboarding is a deterministic form-in-chat (see `server/onboarding.ts`): it
 * owns the list of required variables and the asking. Penny opens with "tell me
 * about your trip", and the driver can answer with anything from "I want to go
 * to Alaska" (nothing pre-filled) to "Austin to Alaska, leaving tomorrow, over
 * seven days" (start date already stated). This module is the ONE place the
 * opening message is scanned: a small forced-tool model reads it and transcribes
 * which onboarding variables it can fill. The model only converts prose into the
 * declared shape — it does NOT author values or drive the flow. The server then
 * re-validates every field before anything is trusted, and onboarding skips (or
 * prefills) the questions that came back filled.
 *
 * Design mirrors `parseStartDate.ts` / `parseRangeEstimate.ts`:
 *   - forced tool call (the schema IS the contract; no prose to scrape),
 *   - every field nullable with "return null rather than guess" instructions,
 *   - strict server-side re-validation (a hallucinated value can't reach the DB),
 *   - never throws: returns an all-null result on no key / error / timeout.
 *
 * Extending: add a nullable field to SCAN_TOOL + a validated mapping below, then
 * wire its onboarding question to consult the result. Keep safety-critical fields
 * (fuel range) confirm-don't-assume in onboarding — see the wiring there.
 */

// Lazily constructed so importing this module never throws without an API key
// (unit tests, build pass). The SDK constructor throws on a missing key.
let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Onboarding is interactive — bound the wait and fall through to asking rather
// than hang the first message on a slow model call.
const SCAN_TIMEOUT_MS = 6000;

const SCAN_TOOL: Anthropic.Tool = {
  name: 'record_onboarding_fields',
  description:
    'Record any onboarding fields explicitly present in the driver’s opening ' +
    'trip description. Every field is nullable — return null for anything not ' +
    'clearly stated. Do NOT guess.',
  input_schema: {
    type: 'object',
    required: ['start_date_phrase', 'origin_place', 'daily_drive_hours', 'range_km'],
    properties: {
      daily_drive_hours: {
        type: ['integer', 'null'],
        description:
          'How many hours a day the driver said they want to DRIVE, as a whole number, ' +
          'ONLY if explicitly stated ("5 h days" → 5, "drive about 6 hours a day" → 6, ' +
          '"short 4-hour days" → 4). null when no daily driving time is mentioned. ' +
          'Do NOT infer it from the trip length or the distance.',
      },
      origin_place: {
        type: ['string', 'null'],
        description:
          'Where the trip STARTS, copied verbatim, ONLY if the driver explicitly ' +
          'named a starting point ("Paris to Stuttgart" → "Paris", "from Girona", ' +
          '"leaving Austin", "starting in Lyon"). A message that names only a ' +
          'destination ("Annecy, France", "I want to go to Alaska") has NO origin — ' +
          'return null. Never infer the origin from a destination, a nationality or ' +
          'anything not stated.',
      },
      start_date_phrase: {
        type: ['string', 'null'],
        description:
          'The exact words the driver used for WHEN the trip starts, copied verbatim ' +
          '("tomorrow", "next Saturday", "November 1st", "in two weeks", "this summer"). ' +
          'Do NOT resolve it to a date — just extract the phrase. null when no start ' +
          'time is mentioned at all.',
      },
      range_km: {
        type: ['integer', 'null'],
        description:
          'The driver’s usual driving range between refuels, in WHOLE ' +
          'kilometers, ONLY if they explicitly stated it (e.g. "about 400km on a tank", ' +
          '"I refuel every 300 km", "comfortable for 250 miles" → convert to ~402). ' +
          'Convert from miles when the driver used miles. null when no range/refuel ' +
          'distance is stated. Do NOT infer from vehicle make/model here.',
      },
    },
  },
};

/** Validated result of scanning the opening message. All fields null-safe. */
export interface OnboardingScanResult {
  /** Resolved trip start date, or null when none was stated / it didn't resolve. */
  startDate: ResolvedStartDate | null;
  /** Validated fuel range (km), or null. */
  rangeKm: number | null;
  /** The verbatim start-date phrase the model extracted (for the free-text column). */
  startDatePhrase: string | null;
  /** Where the trip starts, verbatim, or null when the message named no origin. */
  originPlace: string | null;
  /** Hours of driving a day the driver asked for, in band, or null. */
  dailyDriveHours: number | null;
}

/** An all-null scan result (no signal / no key / error). */
function emptyResult(): OnboardingScanResult {
  return {
    startDate: null,
    rangeKm: null,
    startDatePhrase: null,
    originPlace: null,
    dailyDriveHours: null,
  };
}

/** A place name is bounded and single-line; anything else is treated as absent. */
const MAX_ORIGIN_CHARS = 120;

/**
 * Validate the raw origin the model returned: a non-empty single-line string
 * of bounded length. Pure — exported for unit testing.
 */
export function validateScannedOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_ORIGIN_CHARS) return null;
  return t;
}

/**
 * Validate the raw range the model returned: a whole number in the product band
 * (`validateRangeKm`); an out-of-band value becomes null. Pure — exported
 * for unit testing.
 */
export function validateScannedRange(rawRange: unknown): {
  rangeKm: number | null;
} {
  return { rangeKm: validateRangeKm(rawRange) };
}

interface ScanOpts {
  /** Injectable clock for tests + relative-date anchoring. */
  now?: Date;
  /** For usage accounting; logging is skipped when absent. */
  userId?: string;
  tripId?: string;
}

/**
 * Scan the driver's opening trip description for onboarding variables. Returns a
 * fully-validated result (the start-date phrase is resolved through the shared
 * `resolveStartDate`, never authored by this model directly). Never throws.
 */
export async function scanFirstMessage(
  text: string,
  opts: ScanOpts = {},
): Promise<OnboardingScanResult> {
  const anthropic = getClient();
  if (!anthropic) return emptyResult();
  const trimmed = text.trim();
  if (!trimmed) return emptyResult();

  const system =
    `You read a road-tripper's opening message to a trip planner and record any ` +
    `onboarding fields it explicitly contains via the record_onboarding_fields tool. ` +
    `Call that tool exactly once; output nothing else.\n` +
    `- Only fill a field when the driver clearly stated it. Return null for anything ` +
    `not explicitly present — never guess, never infer from context.\n` +
    `- start_date_phrase: copy the WHEN words verbatim; do not convert to a date.\n` +
    `- origin_place: only a STARTING point the driver named; a destination alone ` +
    `means null.\n` +
    `- daily_drive_hours: only an explicit hours-per-day of driving; null otherwise.\n` +
    `- ranges: only when an actual distance-per-tank or refuel distance is stated; ` +
    `convert miles to km; leave null otherwise.`;

  let resp: Anthropic.Message;
  try {
    resp = await anthropic.messages.create(
      {
        model: ONBOARDING_SCAN_MODEL,
        max_tokens: 256,
        temperature: 0,
        system,
        tools: [SCAN_TOOL],
        tool_choice: { type: 'tool', name: SCAN_TOOL.name },
        // Generous slice — the opening message can be a full trip description.
        messages: [{ role: 'user', content: trimmed.slice(0, 2000) }],
      },
      { timeout: SCAN_TIMEOUT_MS },
    );
  } catch (err) {
    console.warn(
      `[onboardingIntentScan] scan failed (model=${ONBOARDING_SCAN_MODEL}): ${
        (err as Error)?.message ?? err
      }`,
    );
    return emptyResult();
  }

  // Best-effort usage accounting — never let it block or throw.
  if (opts.userId) {
    void logAnthropicUsageWithFallback({
      userId: opts.userId,
      tripId: opts.tripId ?? null,
      model: ONBOARDING_SCAN_MODEL,
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
      cacheCreationInputTokens: resp.usage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: resp.usage?.cache_read_input_tokens ?? 0,
      success: true,
    }).catch(() => {});
  }

  const toolUse = resp.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === 'tool_use' && b.name === SCAN_TOOL.name,
  );
  if (!toolUse) return emptyResult();
  const input = (toolUse.input ?? {}) as {
    start_date_phrase?: unknown;
    origin_place?: unknown;
    daily_drive_hours?: unknown;
    range_km?: unknown;
  };

  const { rangeKm } = validateScannedRange(input.range_km);
  const originPlace = validateScannedOrigin(input.origin_place);
  // The same band the pace step itself accepts; out of band is treated as unsaid.
  const dailyDriveHours = parseDailyDriveHours(input.daily_drive_hours);

  // Resolve the date phrase through the shared resolver — the scan model only
  // extracted the words; resolveStartDate (deterministic parse first, then its
  // own forced-tool LLM) owns turning them into a validated ISO + assumed flag.
  let startDate: ResolvedStartDate | null = null;
  let startDatePhrase: string | null = null;
  if (typeof input.start_date_phrase === 'string' && input.start_date_phrase.trim()) {
    startDatePhrase = input.start_date_phrase.trim().slice(0, 200);
    const resolved = await resolveStartDate(startDatePhrase, {
      now: opts.now,
      userId: opts.userId,
      tripId: opts.tripId,
    });
    startDate = resolved.iso ? resolved : null;
    if (!startDate) startDatePhrase = null;
  }

  return { startDate, rangeKm, startDatePhrase, originPlace, dailyDriveHours };
}
